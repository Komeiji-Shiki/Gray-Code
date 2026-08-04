/**
 * 文件写锁管理器
 *
 * 修改原因：SubAgent 并行执行后，多个 agent（或 agent 与主会话）可能同时修改同一文件导致互相覆盖。
 * 修改方式：提供进程级全局的路径互斥锁；写类工具执行前 tryAcquire，撞车时立即返回冲突详情（非阻塞）。
 * 修改目的：后来者收到"该文件正被 X 修改，先处理任务其他部分，稍后再回来"的提示，由 LLM 自行调度，避免死等与死锁。
 */

/**
 * 锁持有者标识。
 */
export interface LockHolder {
    /** 'main' = 主会话；'subagent' = 子代理 run；'checkpoint' = 存档操作 */
    kind: 'main' | 'subagent' | 'checkpoint';
    /** 唯一标识：conversationId 或 runId */
    id: string;
    /** 展示名：撞车提示中告知对方是谁在占用（如 agent 名称或 'main session'） */
    label: string;
}

/** 单个路径的锁冲突信息 */
export interface LockConflict {
    path: string;
    holder: LockHolder;
}

export type TryAcquireResult =
    | { acquired: true }
    | { acquired: false; conflicts: LockConflict[] };

interface LockEntry {
    holder: LockHolder;
    /** 原始（未归一化）路径，用于提示展示 */
    displayPath: string;
    /** 同 holder 重入计数 */
    count: number;
}

/**
 * 归一化路径为锁 key。
 *
 * - 反斜杠统一为斜杠；
 * - 去除开头 './' 与末尾 '/'；
 * - 小写化（Windows 文件系统不区分大小写；其他平台上保守地按不区分处理）；
 * - '.'、'' 归一为 ''，表示整个 workspace 根（与所有路径冲突）。
 */
export function normalizeLockPath(rawPath: string): string {
    let p = String(rawPath || '').replace(/\\/g, '/').trim();
    while (p.startsWith('./')) {
        p = p.slice(2);
    }
    p = p.replace(/\/+$/g, '');
    if (p === '.' || p === '') {
        return '';
    }
    // 折叠重复分隔符
    p = p.replace(/\/{2,}/g, '/');
    return p.toLowerCase();
}

/**
 * 判断两个归一化 key 是否互斥。
 *
 * 相同路径互斥；祖先目录与其内部路径互斥（'' 是所有路径的祖先）。
 */
function keysConflict(a: string, b: string): boolean {
    if (a === b) return true;
    if (a === '' || b === '') return true;
    return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 写类工具的目标路径提取注册表。
 *
 * 不在注册表中的工具（全部只读工具与 MCP 工具）不参与写锁。
 * search_in_files 仅在 replace 模式下锁定目标路径（可能是目录，按祖先规则互斥）。
 */
const WRITE_PATH_EXTRACTORS: Record<string, (args: Record<string, unknown>) => string[]> = {
    write_file: extractSinglePath,
    apply_diff: extractSinglePath,
    insert_code: args => extractFilesArrayPaths(args.files),
    delete_code: args => extractFilesArrayPaths(args.files),
    delete_file: args => extractStringArray(args.paths),
    create_directory: args => extractStringArray(args.paths),
    search_in_files: args => {
        if (args.mode !== 'replace') return [];
        const target = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
        return [target];
    },
    // 修改原因：文档类工具同样写文件，之前完全不参与写锁；
    // 多个 SubAgent 并发更新 progress.md/review 文档恰是写锁要防的典型场景。
    // create_* 未显式给 path 时目标路径由工具内部生成、无法预知，不加锁。
    create_plan: extractSinglePath,
    update_plan: extractSinglePath,
    create_design: extractSinglePath,
    update_design: extractSinglePath,
    create_review: extractSinglePath,
    record_review_milestone: extractSinglePath,
    finalize_review: extractSinglePath,
    reopen_review: extractSinglePath,
    // progress 三工具的默认目标固定为 .graycode/progress.md，缺省时锁默认路径
    create_progress: extractProgressPath,
    update_progress: extractProgressPath,
    record_progress_milestone: extractProgressPath
};

/** 单 path 参数提取；空白 path 不加锁（以前 '' 会被归一为整个 workspace 根锁） */
function extractSinglePath(args: Record<string, unknown>): string[] {
    return typeof args.path === 'string' && args.path.trim() ? [args.path] : [];
}

const DEFAULT_PROGRESS_PATH = '.graycode/progress.md';

function extractProgressPath(args: Record<string, unknown>): string[] {
    return [typeof args.path === 'string' && args.path.trim() ? args.path : DEFAULT_PROGRESS_PATH];
}

function extractFilesArrayPaths(files: unknown): string[] {
    if (!Array.isArray(files)) return [];
    return files
        .map(item => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string')
            ? (item as Record<string, unknown>).path as string
            : null)
        .filter((p): p is string => !!p);
}

function extractStringArray(paths: unknown): string[] {
    if (!Array.isArray(paths)) return [];
    return paths.filter((p): p is string => typeof p === 'string');
}

/**
 * 获取工具调用的写目标路径。
 *
 * @returns null 表示该工具不参与写锁；空数组表示写工具但参数里没有可提取的路径（同样不加锁）。
 */
export function getWritePathsForCall(toolName: string, args: Record<string, unknown>): string[] | null {
    const extractor = WRITE_PATH_EXTRACTORS[toolName];
    if (!extractor) return null;
    try {
        return extractor(args || {});
    } catch {
        return [];
    }
}

/**
 * 进程级文件写锁管理器。
 *
 * - 非阻塞：tryAcquire 失败立即返回冲突详情，不排队不等待；
 * - 全有或全无：多路径调用中任一路径冲突则整体失败、不留下部分锁；
 * - 同 holder 重入允许（计数）；
 * - releaseAllByHolder 供 run 结束/异常退出时兜底清理。
 */
export class FileWriteLockManager {
    private readonly locks = new Map<string, LockEntry>();

    tryAcquire(paths: string[], holder: LockHolder): TryAcquireResult {
        const keys = paths.map(p => ({ key: normalizeLockPath(p), display: p }));
        const conflicts: LockConflict[] = [];

        for (const { key } of keys) {
            for (const [existingKey, entry] of this.locks) {
                if (entry.holder.id === holder.id) {
                    continue;
                }
                if (keysConflict(key, existingKey)) {
                    conflicts.push({ path: entry.displayPath, holder: entry.holder });
                }
            }
        }

        if (conflicts.length > 0) {
            // 去重（同一持有者/路径可能被多个请求路径命中）
            const seen = new Set<string>();
            const unique = conflicts.filter(c => {
                const dedupeKey = `${c.holder.id}:${c.path}`;
                if (seen.has(dedupeKey)) return false;
                seen.add(dedupeKey);
                return true;
            });
            return { acquired: false, conflicts: unique };
        }

        for (const { key, display } of keys) {
            const existing = this.locks.get(key);
            if (existing && existing.holder.id === holder.id) {
                existing.count += 1;
            } else {
                this.locks.set(key, { holder, displayPath: display, count: 1 });
            }
        }
        return { acquired: true };
    }

    async acquire(paths: string[], holder: LockHolder, abortSignal?: AbortSignal): Promise<void> {
        while (true) {
            if (abortSignal?.aborted) {
                throw new Error('File write lock acquisition was cancelled');
            }

            const result = this.tryAcquire(paths, holder);
            if (result.acquired) return;

            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve();
                }, 25);
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    abortSignal?.removeEventListener('abort', onAbort);
                    reject(new Error('File write lock acquisition was cancelled'));
                };
                abortSignal?.addEventListener('abort', onAbort, { once: true });
            });
        }
    }

    release(paths: string[], holder: LockHolder): void {
        for (const p of paths) {
            const key = normalizeLockPath(p);
            const entry = this.locks.get(key);
            if (!entry || entry.holder.id !== holder.id) {
                continue;
            }
            entry.count -= 1;
            if (entry.count <= 0) {
                this.locks.delete(key);
            }
        }
    }

    /**
     * 释放指定持有者的全部锁（run 结束/会话中止时的兜底清理）。
     */
    releaseAllByHolder(holderId: string): void {
        for (const [key, entry] of this.locks) {
            if (entry.holder.id === holderId) {
                this.locks.delete(key);
            }
        }
    }

    /** 当前持有的锁数量（测试与诊断用） */
    getLockCount(): number {
        return this.locks.size;
    }
}

/**
 * 全局单例：主会话与所有 SubAgent 共享同一套锁。
 */
export const fileWriteLockManager = new FileWriteLockManager();
