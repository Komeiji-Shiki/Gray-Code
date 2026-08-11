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
import * as path from 'path';
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

    /** 移除磁盘上已不存在的对话（listConversations 之后调用）；dirty 集合同步清理 */
    prune(keepIds: ReadonlySet<string>): void {
        for (const id of [...this.entries.keys()]) {
            if (!keepIds.has(id)) {
                this.entries.delete(id);
            }
        }
        // 已删除会话的 dirty 标记若不清理，会在 takeDirty 中残留为待重读会话
        // （无害但属无效条目，且会阻止该 ID 重建后直接命中内存缓存）
        for (const id of [...this.dirty]) {
            if (!keepIds.has(id)) {
                this.dirty.delete(id);
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
    // 原子写临时文件（{id}.meta.json.tmp / {id}.usage.json.tmp）先剥掉 .tmp 再识别，
    // 否则会被当成假对话 ID（形如 xxx.usage.json.tmp）标记进 dirty 集合
    const base = top.endsWith('.tmp') ? top.slice(0, -'.tmp'.length) : top;
    // 双后缀优先：{id}.meta.json（改名）与 {id}.usage.json（索引写入）都要映射回真实对话
    for (const suffix of ['.meta.json', '.usage.json', '.json']) {
        if (base.endsWith(suffix)) {
            return base.slice(0, -suffix.length);
        }
    }
    return base;
}

/** 递归能力探测超时（毫秒） */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
/** 非递归降级时 mtime 快照扫描间隔（毫秒） */
const DEFAULT_FALLBACK_SCAN_INTERVAL_MS = 15_000;
/** 探测探针目录名前缀（扫描器跳过，避免把探针文件计入 mtime 快照） */
const PROBE_DIR_PREFIX = '.usage-watch-probe-';

/**
 * 递归能力探测：在受监听目录内创建探针子目录并写入探针文件，
 * 若 watcher 在超时内收到“探针子目录内部文件”的事件，说明 recursive 生效。
 *
 * 只把“探针目录内部”的事件视为递归证据：非递归 watcher 也会收到子目录本身的创建
 * 事件，但那不能证明能观察到子目录内的文件变更（旧 Node / 部分平台 fs.watch
 * 的 recursive 选项创建时不抛错但静默降级为非递归）。
 *
 * 探测不经过调用方事件处理（另挂临时 change 监听，探测期间探针事件不会误标 dirty）；
 * 返回 false 时调用方应退化为 mtime 快照比对。
 */
export function probeRecursiveWatchSupport(
    watcher: fs.FSWatcher,
    conversationsDirPath: string,
    timeoutMs: number
): Promise<boolean> {
    const probeDir = path.join(conversationsDirPath, `${PROBE_DIR_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const probeBase = path.basename(probeDir);
    return new Promise<boolean>((resolve) => {
        let settled = false;

        function finish(ok: boolean): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            watcher.removeListener('change', onChange);
            try {
                fs.rmSync(probeDir, { recursive: true, force: true });
            } catch {
                // 忽略清理失败
            }
            resolve(ok);
        }

        function onChange(_event: string, filename: string | Buffer | null): void {
            const raw = typeof filename === 'string' ? filename : filename?.toString();
            if (!raw) return;
            if (raw.replace(/\\/g, '/').includes(`${probeBase}/`)) {
                finish(true);
            }
        }

        const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
        watcher.on('change', onChange);
        try {
            fs.mkdirSync(probeDir, { recursive: true });
            fs.writeFileSync(path.join(probeDir, 'probe.txt'), 'probe');
        } catch {
            finish(false);
        }
    });
}

/**
 * 递归不可用时的降级路径：扫描 conversations 目录下所有文件的 mtime，
 * 每个对话取最大 mtime（写历史/元数据/索引都会触碰对应文件）。
 * 目录不存在或不可读时返回空 Map。
 * 异步迭代（fs.promises.readdir/stat）：避免 readdirSync/statSync 在大目录下同步阻塞事件循环。
 */
export async function scanConversationMtimes(conversationsDirPath: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(PROBE_DIR_PREFIX)) continue; // 跳过探测残留
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), rel);
                continue;
            }
            const conversationId = parseConversationIdFromPath(rel);
            if (!conversationId) continue;
            try {
                const stat = await fs.promises.stat(path.join(dir, entry.name));
                const mtime = stat.mtimeMs;
                const prev = result.get(conversationId);
                if (prev === undefined || mtime > prev) {
                    result.set(conversationId, mtime);
                }
            } catch {
                // 文件可能已并发删除，忽略
            }
        }
    };
    await walk(conversationsDirPath, '');
    return result;
}

/** 两次 mtime 快照间发生变化的对话（新增/变更；删除由 listConversations + prune 处理） */
export function diffMtimeSnapshots(previous: Map<string, number>, current: Map<string, number>): string[] {
    const changed: string[] = [];
    for (const [id, mtime] of current) {
        if (previous.get(id) !== mtime) {
            changed.push(id);
        }
    }
    return changed;
}

/**
 * 非递归降级兜底：定期对 conversations 目录做 mtime 快照比对，
 * 把 mtime 变化的对话标记为 dirty（等价于 recursive watcher 的失效信号）。
 * 首次扫描只建立基线不标记 dirty，避免启动即全量失效。返回停止函数（清定时器）。
 */
export function startMtimeFallbackScanner(
    conversationsDirPath: string,
    cache: UsageStatsCache,
    intervalMs: number = DEFAULT_FALLBACK_SCAN_INTERVAL_MS
): () => void {
    let baseline: Map<string, number> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let scanning = false; // 防重入：扫描慢于周期时跳过本次 tick，下一 tick 继续（保持 15s 周期语义）
    const scan = async (): Promise<void> => {
        if (scanning) return;
        scanning = true;
        try {
            const current = await scanConversationMtimes(conversationsDirPath);
            if (baseline) {
                for (const id of diffMtimeSnapshots(baseline, current)) {
                    cache.markDirty(id);
                }
            }
            baseline = current;
        } finally {
            scanning = false;
        }
    };
    void scan();
    timer = setInterval(() => { void scan(); }, intervalMs);
    return () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/**
 * 监听 conversations 目录，文件变更时把对应对话标记为 dirty。
 *
 * - recursive：segmented 历史写入发生在 {id}/ 子目录内，必须递归监听；
 * - 创建后做递归能力探测：部分旧 Node / 平台对 recursive 静默降级为非递归，
 *   探测失败时退化为 mtime 快照比对（startMtimeFallbackScanner），避免缓存永久陈旧；
 * - 目录不存在（首次启动）时定期重试，退避上限 30 秒；
 * - watcher 异常时自动重建（同样退避），避免监听静默失效；
 * - 返回 dispose 函数：停止监听并清理定时器（扩展 dispose 时调用）。
 */
export function startUsageDirectoryWatcher(
    conversationsDirPath: string,
    cache: UsageStatsCache,
    options?: { probeTimeoutMs?: number; fallbackScanIntervalMs?: number }
): () => void {
    const probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const fallbackScanIntervalMs = options?.fallbackScanIntervalMs ?? DEFAULT_FALLBACK_SCAN_INTERVAL_MS;
    let stopped = false;
    let watcher: fs.FSWatcher | null = null;
    let restartTimer: NodeJS.Timeout | null = null;
    let retryDelayMs = 1000;
    /** 递归能力探测结果：null=未探测，true=recursive 生效，false=已降级 */
    let recursiveSupported: boolean | null = null;
    /** 非递归降级：mtime 快照扫描器（探测失败时启动，watcher 重建后复用，不重复探测） */
    let fallbackScanner: (() => void) | null = null;

    const stopFallbackScanner = (): void => {
        fallbackScanner?.();
        fallbackScanner = null;
    };

    const closeWatcher = (): void => {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        stopFallbackScanner();
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
        // 跳过递归能力探测的探针目录：探针事件会被 parseConversationIdFromPath
        // 解析成假会话 ID 标记 dirty，探测承诺不污染调用方事件处理
        if (raw.replace(/\\/g, '/').startsWith(PROBE_DIR_PREFIX)) return;
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
            if (recursiveSupported === false) {
                // 已知不支持递归：直接启动 mtime 快照兜底，不再重复探测
                if (!fallbackScanner) {
                    fallbackScanner = startMtimeFallbackScanner(conversationsDirPath, cache, fallbackScanIntervalMs);
                }
            } else {
                void probeRecursiveWatchSupport(watcher, conversationsDirPath, probeTimeoutMs).then(ok => {
                    if (stopped) return;
                    recursiveSupported = ok;
                    if (!ok && !fallbackScanner) {
                        fallbackScanner = startMtimeFallbackScanner(conversationsDirPath, cache, fallbackScanIntervalMs);
                    }
                });
            }
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
