/**
 * 用量统计的内存明细缓存 + 对话目录变更监听
 *
 * 背景：即使有 FileUsageIndexStore，每次统计仍要对每个对话做
 * 2~3 次 stat（历史 ×2 + 索引 ×1）+ 读索引 + 读元数据，对话多时
 * 几千次跨进程文件调用，加载依然明显变慢。
 *
 * 本模块提供两层加速：
 * 1. UsageStatsCache：内存保存每个对话的消息级 token 明细
 *    （与 usage.json 索引同构），统计时直接重放，跳过全部文件 IO；
 * 2. startUsageDirectoryWatcher：用 Node fs.watch 监听 conversations
 *    目录，任何写入（本扩展或外部程序）都把对应对话标记为 dirty，
 *    统计只重读 dirty 对话，其余直接命中内存缓存。
 *
 * 正确性边界：
 * - watcher 事件只作为"失效信号"，数据永远从磁盘重读，不会凭空产生；
 * - 统计开始时取走并清空脏集合，统计期间新到达的事件保留到下一轮；
 * - 统计自身重建索引写 usage.json 会触发事件（自伤），下一轮统计
 *   会重读一次该对话（读小索引文件，不写文件），之后自然恢复命中，
 *   不会无限循环；
 * - 目录尚不存在（首次启动）或 watcher 异常时定期重试/自动重启；
 * - 拿不到目录（内存存储等）时调用方不启用本模块，退化全量扫描。
 */

import * as fs from 'fs';
import type { UsageIndexMessage } from './usageStats';

/** 单个对话的用量快照（内存缓存条目） */
export interface UsageConversationEntry {
    /** 对话标题（trim 后；缺失为空串，展示端回退对话 ID） */
    title: string;
    /** 最后更新时间（毫秒） */
    updatedAt: number;
    /** 消息级 token 明细（与 UsageIndex.messages 同构） */
    messages: UsageIndexMessage[];
}

/**
 * 用量统计内存缓存
 *
 * 线程模型：扩展宿主的全部统计与写路径在同一个事件循环内，
 * 不涉及跨线程共享，Map/Set 无需加锁。
 */
export class UsageStatsCache {
    private entries = new Map<string, UsageConversationEntry>();
    private dirty = new Set<string>();

    has(conversationId: string): boolean {
        return this.entries.has(conversationId);
    }

    get(conversationId: string): UsageConversationEntry | undefined {
        return this.entries.get(conversationId);
    }

    set(conversationId: string, entry: UsageConversationEntry): void {
        this.entries.set(conversationId, entry);
    }

    delete(conversationId: string): void {
        this.entries.delete(conversationId);
        this.dirty.delete(conversationId);
    }

    /** 目录监听回调：标记对话已变更，下次统计必须重读 */
    markDirty(conversationId: string): void {
        this.dirty.add(conversationId);
    }

    /** 查询对话是否处于待重读状态（watcher 已标记但尚未被统计消费） */
    isDirty(conversationId: string): boolean {
        return this.dirty.has(conversationId);
    }

    /** 统计开始时消费：取走并清空脏集合（统计期间新事件保留到下一轮） */
    takeDirty(): string[] {
        const ids = [...this.dirty];
        this.dirty.clear();
        return ids;
    }

    /** 移除磁盘上已不存在的对话（listConversations 之后调用） */
    prune(keepIds: ReadonlySet<string>): void {
        for (const id of [...this.entries.keys()]) {
            if (!keepIds.has(id)) {
                this.entries.delete(id);
            }
        }
    }

    clear(): void {
        this.entries.clear();
        this.dirty.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

/**
 * 从 watcher 事件文件名解析对话 ID（纯函数，便于单测）。
 *
 * 输入是相对 conversations 目录的路径（Windows 用反斜杠分隔）：
 * - `abc.json` → `abc`；`abc.meta.json` / `abc.usage.json` → `abc`（双后缀优先）
 * - `abc/segment-1.json` / `abc/.tmp/xxx` → `abc`
 * 空输入返回 undefined。
 */
export function parseConversationIdFromPath(filename: string): string | undefined {
    const normalized = filename.replace(/\\/g, '/');
    const top = normalized.split('/')[0];
    if (!top) return undefined;
    // 双后缀优先：{id}.meta.json（改名）与 {id}.usage.json（索引写入）都要映射回真实对话
    for (const suffix of ['.meta.json', '.usage.json', '.json']) {
        if (top.endsWith(suffix)) {
            return top.slice(0, -suffix.length);
        }
    }
    return top;
}

/**
 * 监听 conversations 目录，文件变更时把对应对话标记为 dirty。
 *
 * - recursive：segmented 历史写入发生在 {id}/ 子目录内，必须递归监听；
 * - 目录不存在（首次启动）时定期重试，退避上限 30 秒；
 * - watcher 异常时自动重建（同样退避），避免监听静默失效；
 * - 返回 dispose 函数：停止监听并清理定时器（扩展 dispose 时调用）。
 */
export function startUsageDirectoryWatcher(
    conversationsDirPath: string,
    cache: UsageStatsCache
): () => void {
    let stopped = false;
    let watcher: fs.FSWatcher | null = null;
    let restartTimer: NodeJS.Timeout | null = null;
    let retryDelayMs = 1000;

    const closeWatcher = (): void => {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        if (watcher) {
            try {
                watcher.close();
            } catch {
                // 已关闭或损坏的 watcher，忽略
            }
            watcher = null;
        }
    };

    const scheduleRestart = (): void => {
        if (stopped || restartTimer) return;
        restartTimer = setTimeout(() => {
            restartTimer = null;
            start();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    };

    const handleEvent = (_event: string, filename: string | Buffer | null): void => {
        const raw = typeof filename === 'string' ? filename : filename?.toString();
        if (!raw) return;
        const conversationId = parseConversationIdFromPath(raw);
        if (!conversationId) return;
        cache.markDirty(conversationId);
    };

    const start = (): void => {
        if (stopped) return;
        try {
            if (!fs.existsSync(conversationsDirPath)) {
                scheduleRestart();
                return;
            }
            watcher = fs.watch(conversationsDirPath, { recursive: true }, handleEvent);
            retryDelayMs = 1000; // 监听建立成功，重置退避
            watcher.on('error', () => {
                closeWatcher();
                scheduleRestart();
            });
        } catch {
            scheduleRestart();
        }
    };

    start();

    return () => {
        stopped = true;
        closeWatcher();
    };
}
