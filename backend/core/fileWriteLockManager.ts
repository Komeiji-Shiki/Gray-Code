/**
 * 文件写锁管理器
 *
 * 修改原因：SubAgent 并行执行后，多个 agent（或 agent 与主会话）可能同时修改同一文件导致互相覆盖。
 * 修改方式：提供进程级全局的路径互斥锁；写类工具执行前 tryAcquire，撞车时立即返回冲突详情（非阻塞）。
 * 修改目的：后来者收到"该文件正被 X 修改，先处理任务其他部分，稍后再回来"的提示，由 LLM 自行调度，避免死等与死锁。
 */

import * as path from 'path';
import { resolveFileToolPathWithInfo } from '../tools/utils';

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
 * 持有者身份键：kind + id 组合。
 *
 * 修改原因：不同 kind（main/subagent/checkpoint）可能使用相同 id（如 conversationId 与 runId 撞车），
 * 仅比较 id 会把不同 kind 的持有者误判为同一人，导致互斥失效或重入误判。
 * 修改方式：所有身份比较与 acquiredKeysByHolder 的键统一使用 `${kind}:${id}`。
 */
function holderIdentity(holder: LockHolder): string {
    return `${holder.kind}:${holder.id}`;
}

/**
 * 归一化路径为锁 key。
 *
 * - 反斜杠统一为斜杠；
 * - 去除开头 './' 与末尾 '/'；
 * - 折叠 `..` 段（`a/../b` 与 `b` 指向同一文件，必须命中同一把锁）；
 * - Windows 平台小写化（文件系统不区分大小写）；其他平台保留原始大小写；
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
    // 折叠重复分隔符与 .. 段（posix normalize 只做纯字符串折叠，
    // 不依赖进程 cwd，也不会触碰盘符前缀）
    p = path.posix.normalize(p);
    // 仅 Windows 文件系统不区分大小写时才小写；其他平台保留大小写，避免破坏大小写敏感文件系统的互斥语义
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 把写目标原始路径解析为绝对规范路径（锁 key 的输入）。
 *
 * 修改原因：旧实现直接用模型提供的原始路径做锁 key，只做大小写/分隔符/./前缀归一，
 * 不解析 .. 与相对/绝对路径等价关系——同一物理文件的不同写法会得到不同 key，
 * 可以绕过互斥锁导致并行覆盖。
 * 修改方式：加锁前统一解析为绝对规范形式：
 * - 空串 '' 保持 ''（整个 workspace 根锁，与所有路径互斥；checkpoint 存档锁依赖此语义）；
 * - 相对路径 / 工作区前缀路径 / file:// URI 复用 resolveFileToolPathWithInfo 解析为绝对
 *   fsPath（保留多工作区前缀与工作区外绝对路径语义，与工具侧解析口径一致）；
 * - 解析失败（无工作区、多工作区未加前缀等）回退 path.resolve，保证同一写法仍映射到同一 key。
 */
export function resolveLockPath(rawPath: string): string {
    const trimmed = String(rawPath || '').trim();
    if (trimmed === '') {
        return '';
    }
    try {
        const info = resolveFileToolPathWithInfo(trimmed);
        if (info.uri?.fsPath) {
            return info.uri.fsPath;
        }
    } catch {
        // 解析异常时回退 path.resolve，保持确定性
    }
    return path.resolve(trimmed);
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
        // 过滤空/空白串：'' 会被归一为整个 workspace 根锁，与所有写路径互斥
        .filter((p): p is string => !!p && p.trim() !== '');
}

function extractStringArray(paths: unknown): string[] {
    if (!Array.isArray(paths)) return [];
    // 过滤空/空白串：'' 会被归一为整个 workspace 根锁，与所有写路径互斥
    return paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
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
    } catch (error) {
        // 提取失败不再静默吞掉：告警提示（含异常），同时保持空数组兜底，避免单次提取失败阻断整个写流程
        console.warn(`[fileWriteLockManager] extract write paths failed for tool "${toolName}"`, error);
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

    /** holder 身份键（`${kind}:${id}`）-> (原始路径 -> acquire 时解析出的锁 key)；release 复用，避免工作区变化导致 key 漂移 */
    private readonly acquiredKeysByHolder = new Map<string, Map<string, string>>();

    /** 锁集合变化代际：release / releaseAllByHolder 真正释放锁时自增，用于唤醒等待 acquire 的调用方 */
    private lockGeneration = 0;
    /** 等待锁释放的 acquire 等待者（释放时 notify 唤醒；acquire 内 50ms 兜底轮询防唤醒丢失） */
    private generationWaiters: Array<() => void> = [];

    /** 锁被实际释放（从集合删除）时自增代际并唤醒全部等待者 */
    private bumpLockGeneration(): void {
        this.lockGeneration++;
        const waiters = this.generationWaiters;
        this.generationWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
    }

    private removeGenerationWaiter(waiter: () => void): void {
        const idx = this.generationWaiters.indexOf(waiter);
        if (idx >= 0) {
            this.generationWaiters.splice(idx, 1);
        }
    }

    tryAcquire(paths: string[], holder: LockHolder): TryAcquireResult {
        // 锁 key 使用绝对规范路径：同一物理文件的不同写法（.. / 相对 / 绝对 / file://）归一为同一 key
        const keys = paths.map(p => ({ key: normalizeLockPath(resolveLockPath(p)), display: p }));

        // 无路径可锁（空/空白路径已被过滤）：直接成功返回，不记录 acquired keys
        if (keys.length === 0) {
            return { acquired: true };
        }

        const conflicts: LockConflict[] = [];

        for (const { key } of keys) {
            for (const [existingKey, entry] of this.locks) {
                // 身份按 kind + id 组合比较：不同 kind 同 id 不算同一持有者
                if (holderIdentity(entry.holder) === holderIdentity(holder)) {
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
                const dedupeKey = `${holderIdentity(c.holder)}:${c.path}`;
                if (seen.has(dedupeKey)) return false;
                seen.add(dedupeKey);
                return true;
            });
            return { acquired: false, conflicts: unique };
        }

        for (const { key, display } of keys) {
            const existing = this.locks.get(key);
            if (existing && holderIdentity(existing.holder) === holderIdentity(holder)) {
                existing.count += 1;
            } else {
                this.locks.set(key, { holder, displayPath: display, count: 1 });
            }
        }
        // 记录本次 acquire 实际解析出的锁 key，供 release 复用（键为 holder 身份 `${kind}:${id}`）
        this.recordAcquiredKeys(holderIdentity(holder), keys);
        return { acquired: true };
    }

    /** 记录持有者各原始路径对应的锁 key（release 时直接复用）；holderId 为 `${kind}:${id}` 身份键 */
    private recordAcquiredKeys(holderId: string, keys: Array<{ key: string; display: string }>): void {
        let map = this.acquiredKeysByHolder.get(holderId);
        if (!map) {
            map = new Map();
            this.acquiredKeysByHolder.set(holderId, map);
        }
        for (const { key, display } of keys) {
            map.set(display, key);
        }
    }

    /** 持有者是否仍持有至少一把锁；holderId 为 `${kind}:${id}` 身份键 */
    private holderHasLocks(holderId: string): boolean {
        for (const entry of this.locks.values()) {
            if (holderIdentity(entry.holder) === holderId) {
                return true;
            }
        }
        return false;
    }

    /**
     * 等待获取全部路径锁（可被 abortSignal 取消）。
     *
     * @param maxWaitMs 整体等待上限，默认 30000ms；超时抛带锁路径信息的可辨识错误，
     *                  传 Infinity 可禁用超时（仅靠 abortSignal 中断）。
     */
    async acquire(paths: string[], holder: LockHolder, abortSignal?: AbortSignal, maxWaitMs = 30000): Promise<void> {
        const startTime = Date.now();
        while (true) {
            if (abortSignal?.aborted) {
                throw new Error('File write lock acquisition was cancelled');
            }
            if (Date.now() - startTime >= maxWaitMs) {
                throw new Error(
                    `File write lock acquisition timed out after ${maxWaitMs}ms; ` +
                    `waiting for paths: ${paths.join(', ')}`
                );
            }

            const result = this.tryAcquire(paths, holder);
            if (result.acquired) return;

            // 等待「锁被释放」的通知（release/releaseAllByHolder 会 bump 代际并唤醒），
            // 而不是固定周期轮询——锁未释放时不再反复做 O(锁数) 冲突扫描空转；
            // 50ms 兜底轮询补上「通知先于注册」的竞态/丢失窗口，保证不会永久睡死。
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const wake = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve();
                };
                // 兜底轮询定时器：代际通知只覆盖「acquire 开始等待之后才发生的释放」，
                // 通知先于注册的竞态窗口内可能丢失唤醒，50ms 上限的兜底保证不会永久睡死；
                // 定时器触发时同样移除 wake（等待者已解决，不应再被代际通知唤醒）
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    this.removeGenerationWaiter(wake);
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve();
                }, 50);
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    this.removeGenerationWaiter(wake);
                    abortSignal?.removeEventListener('abort', onAbort);
                    reject(new Error('File write lock acquisition was cancelled'));
                };
                this.generationWaiters.push(wake);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
            });
        }
    }

    release(paths: string[], holder: LockHolder): void {
        let released = false;
        // 复用 tryAcquire 时记录的锁 key，release 不再重新 resolve：
        // 避免 acquire 之后工作区变化导致同一路径解析出不同 key 而无法释放。
        const holderKey = holderIdentity(holder);
        const holderKeys = this.acquiredKeysByHolder.get(holderKey);
        for (const p of paths) {
            const key = holderKeys?.get(p) ?? normalizeLockPath(resolveLockPath(p));
            const entry = this.locks.get(key);
            if (!entry || holderIdentity(entry.holder) !== holderKey) {
                continue;
            }
            entry.count -= 1;
            if (entry.count <= 0) {
                this.locks.delete(key);
                // 锁真正释放时同步删除其 display->key 记录，避免 acquiredKeysByHolder 条目只增不减
                holderKeys?.delete(p);
                released = true;
            }
        }
        // 持有者已无任何锁时清掉其 path->key 记录，避免无界增长
        if (!this.holderHasLocks(holderKey)) {
            this.acquiredKeysByHolder.delete(holderKey);
        }
        // 只有锁被真正释放（从集合删除）才唤醒等待者：重入计数减少不产生新的获取机会
        if (released) {
            this.bumpLockGeneration();
        }
    }

    /**
     * 释放指定持有者的全部锁（run 结束/会话中止时的兜底清理）。
     *
     * 修改原因：旧实现只按 holder.id 匹配——不同 kind（main/subagent/checkpoint）可能
     * 使用相同 id（如 conversationId 与 runId 撞车），会把其他 kind 的锁误释放（R2 M1）。
     * 修改方式：与 tryAcquire/release 一致，按完整身份 `${kind}:${id}` 匹配。
     */
    releaseAllByHolder(holder: LockHolder): void {
        const holderKey = holderIdentity(holder);
        let released = false;
        for (const [key, entry] of this.locks) {
            if (holderIdentity(entry.holder) === holderKey) {
                this.locks.delete(key);
                released = true;
            }
        }
        // 持有者锁已全部清理，一并删除其 path->key 记录（键为完整身份 `${kind}:${id}`）
        this.acquiredKeysByHolder.delete(holderKey);
        if (released) {
            this.bumpLockGeneration();
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
