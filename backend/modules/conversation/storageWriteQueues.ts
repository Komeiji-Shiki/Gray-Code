/**
 * 会话级写队列与挂起超时（拆分自 storage.ts）。
 *
 * 分段历史写、元数据读改写必须按会话串行化，否则并发写会互相删除/覆盖对方刚写入的文件。
 * 本文件提供 withHangTimeout / runSegmentedHistoryWriteSerialized / withMetadataWriteSerialized
 * 三个底层原语；storage.ts 通过再导出保持 withHangTimeout / withMetadataWriteSerialized 的
 * 既有公共 API 不变（UsageIndexStore / ConversationManager 依赖）。
 */

import { Logger } from '../../core/logger';

const log = Logger.get('storage');

// 同一会话的分段历史写入必须串行化：writeSegmentedHistory 涉及"删目录→重写段→写 index"，
// 并发写会互相删除对方刚写入的段文件，导致 index 与 segment 不一致、历史错位混合。
// 锁只保证写写互斥，读（load）不参与，读侧已有容错。
const segmentedHistoryWriteQueues = new Map<string, Promise<void>>();

/** 分段历史写任务挂起超时：任务长时间不结束视为挂起，超时后队列继续前进（防 Map 条目永久泄漏） */
const SEGMENTED_WRITE_HANG_TIMEOUT_MS = 60000;
/** 元数据链任务挂起超时（元数据写都是小文件，超时取更短值） */
const METADATA_WRITE_HANG_TIMEOUT_MS = 30000;

/**
 * 给 Promise 加挂起超时：超时后本调用的调用方按失败处理（fail-fast，不无限等待）。
 * 注意：底层任务（如卡死的 fs 调用）可能仍在后台运行——各写队列的链尾必须等待底层任务
 * 真正结束（见各队列实现：tail 基于 underlying 而非 current），否则超时后新写入会与
 * 仍在运行的旧任务并发读写同一批文件，互相覆盖/删除，损坏历史、索引与元数据。
 * 调用方应把「队列链尾」挂在底层任务上，把「超时感知」挂在 withHangTimeout 返回值上。
 * 取舍：真正永久卡死的底层任务会让该会话写队列永久排队（liveness 让位于一致性），
 * 正常路径的写操作远小于该阈值、实际不触发。
 *
 * 导出供 UsageIndexStore 等其它模块复用（R2 1.2：用量索引写队列同样需要挂起超时兜底）。
 */
export function withHangTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            log.warn('operationHangTimeout', { label, timeoutMs });
            reject(new Error(`${label} hung for ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

export function runSegmentedHistoryWriteSerialized<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = segmentedHistoryWriteQueues.get(conversationId) ?? Promise.resolve();
    const start = previous.catch(() => undefined);
    // 队列链尾挂在底层任务（underlying）上：即使任务挂起超时（current 提前 reject），
    // 链也不会前进——超时后的旧任务仍在"删目录→重写段→双 rename"，新任务并发启动会
    // 互相覆盖/删除对方刚写入的段文件与 index，造成历史错位混合。代价是挂起任务期间
    // Map 条目保留（正确性优先于条目回收）。
    const underlying = start.then(() => task());
    // 挂起超时从任务真正启动时开始计时（排队等待时间不计入，慢而健康的写入不被误报）
    const current = start.then(() =>
        withHangTimeout(underlying, `segmentedHistoryWrite(${conversationId})`, SEGMENTED_WRITE_HANG_TIMEOUT_MS)
    );
    const tail = underlying.then(() => undefined, () => undefined);
    segmentedHistoryWriteQueues.set(conversationId, tail);
    void tail.then(() => {
        if (segmentedHistoryWriteQueues.get(conversationId) === tail) {
            segmentedHistoryWriteQueues.delete(conversationId);
        }
    });
    return current;
}

// 同一会话的元数据读改写共享串行链：ConversationManager 的 setCustomMetadata/updateCustomMetadata
// 与各存储适配器 saveHistory 内部的 updatedAt 更新必须落在同一条链上。否则两条独立串行链并发时，
// 后写者基于旧 meta 的整体写回会把先写者的 custom 字段覆盖（如 checkpoints 落盘与 trimState 失效并发
// → 检查点列表或裁剪状态丢失）。
interface MetadataChainEntry {
    tail: Promise<void>;
    /** 链是否已结束（淘汰时跳过仍在运行中的链，避免与新链并发整体写回互相覆盖） */
    done: boolean;
}
const metadataWriteChains = new Map<string, MetadataChainEntry>();
const METADATA_WRITE_MAX_KEYS = 10000; // 防 Map 无界增长（正常链完成即删除，上限只兜底极端泄漏）

/**
 * 将元数据读改写动作串行化到会话级共享链上。
 * 链内保证「读 meta → 改 → 整体写回」原子执行，避免并发整体写回互相覆盖。
 */
export async function withMetadataWriteSerialized<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = metadataWriteChains.get(conversationId)?.tail ?? Promise.resolve();
    const start = previous.catch(() => undefined);
    // 与 segmentedHistoryWriteSerialized 同理：链尾挂在底层任务上，挂起超时只让调用方
    // 失败，链不前进——超时后旧任务仍持有"读 meta → 整体写回"的读改写窗口，新任务
    // 并发整体写回会把先写者的 custom 字段覆盖（检查点列表/裁剪状态丢失）。
    // 挂起超时从任务真正启动时开始计时（排队等待时间不计入）。
    const underlying = start.then(() => action());
    const current = start.then(() =>
        withHangTimeout(underlying, `metadataWrite(${conversationId})`, METADATA_WRITE_HANG_TIMEOUT_MS)
    );
    const tail = underlying.then(() => undefined, () => undefined);
    if (metadataWriteChains.size >= METADATA_WRITE_MAX_KEYS) {
        // 容量告警：只淘汰最旧的「已结束」链。运行中的链若被淘汰，会与该会话新链并发
        // 执行「读 meta → 整体写回」，重新引入 custom 字段互相覆盖的问题；挂起中的链
        // 同样不可淘汰（其底层任务仍可能正在写盘，淘汰即放行并发写）。
        for (const key of metadataWriteChains.keys()) {
            if (key === conversationId) continue;
            const entry = metadataWriteChains.get(key);
            if (entry && entry.done) {
                metadataWriteChains.delete(key);
                break;
            }
        }
    }
    const entry: MetadataChainEntry = { tail, done: false };
    metadataWriteChains.set(conversationId, entry);
    void tail.then(() => {
        entry.done = true;
        if (metadataWriteChains.get(conversationId) === entry) {
            metadataWriteChains.delete(conversationId);
        }
    });
    return current;
}
