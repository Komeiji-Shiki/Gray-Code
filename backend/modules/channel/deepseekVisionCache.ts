/**
 * DeepSeek Vision 预处理的结果缓存（LRU）。
 *
 * PDF 栅格化、大图分块、GIF 拆帧都是 CPU 密集型操作，而同一份附件字节
 * 会在多轮对话、请求转发与 token 估算之间反复出现。这里用模块级 LRU
 * 缓存已转换的纯内容结果（与附件名/id 等元数据解耦），使相同输入字节
 * 只渲染一次。
 *
 * 设计要点：
 * - 只缓存成功的 resolved 值，不缓存 in-flight promise：并发请求各自渲染
 *   一次最坏只是重复计算，不会让某个请求的 abort 把共享 promise 连带拒绝。
 * - 键为输入字节的 sha256（+ 区分维度参数），内容键控，附件 id/名称变化
 *   不影响缓存命中。
 * - 双限制：条目数 + 总字节预算；单条目超过预算上限时直接不缓存，
 *   避免单个超大 PDF 挤占整个缓存。
 */
export class LruCache<K, V> {
    private readonly entries = new Map<K, { value: V; size: number }>();
    private totalBytes = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxTotalBytes: number = Number.POSITIVE_INFINITY,
        private readonly maxEntryBytes: number = Number.POSITIVE_INFINITY
    ) {}

    get(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        // Map 迭代顺序即访问顺序：重新插入以刷新 recency。
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V, size: number): void {
        if (size > this.maxEntryBytes) {
            // 单条超过预算：不缓存，避免一条巨无霸把预算打满。
            return;
        }
        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.size;
            this.entries.delete(key);
        }
        this.entries.set(key, { value, size });
        this.totalBytes += size;
        this.evict();
    }

    has(key: K): boolean {
        return this.entries.has(key);
    }

    delete(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        this.totalBytes -= entry.size;
        return this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    get size(): number {
        return this.entries.size;
    }

    get bytes(): number {
        return this.totalBytes;
    }

    private evict(): void {
        while (
            this.entries.size > this.maxEntries
            || this.totalBytes > this.maxTotalBytes
        ) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            const entry = this.entries.get(oldestKey)!;
            this.totalBytes -= entry.size;
            this.entries.delete(oldestKey);
        }
    }
}
