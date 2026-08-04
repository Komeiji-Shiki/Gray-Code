/**
 * 历史段级 LRU 缓存（HIS-06）。
 *
 * 背景：长对话分段历史（history/*.ndjson）每次读取都要解析整段文件；
 * 同一对话在工具循环中会被反复读取（上下文裁剪、API 格式化、统计等），
 * 逐段重复解析带来不必要的 IO 与 CPU 开销。
 *
 * 设计：
 * - 缓存键 = conversationId + segmentFile + historyRevision；
 * - historyRevision 取自 index.totalMessages（任何历史提交都会改变它），
 *   配合“写后失效”（writeSegmentedHistory/appendHistory 提交后整体清除该会话条目），
 *   保证“每次读到最新数据”的语义不被破坏；
 * - 外部进程直接改段文件不会改变 totalMessages：storage.readSegmentCached 会把段文件
 *   mtime + size 纳入缓存键（M5，命中前 stat 比对），变化 → 不同键 → 缓存失效重读；
 * - 内存上限双约束：段数上限（默认 32 段）+ 按字节估算的软上限（默认 64MB），
 *   超过任一上限按 LRU 淘汰（Map 插入序 + 命中刷新）；
 * - 写后失效按 conversationId 分桶（conversationId → 键集合），O(桶大小) 清理，
 *   不再全表扫描；
 * - “活跃对话优先”由 LRU 天然体现：活跃对话的段不断命中，冷段先被淘汰；
 * - 缓存数组与读取方共享元素引用：本类不负责拷贝。storage 层（loadSegmentedHistory /
 *   loadSegmentedHistoryPage）返回前已对元素做浅拷贝（M2），因此调用方对消息顶层属性
 *   的原地赋值不会污染缓存；但对嵌套结构（parts/content 数组）的修改仍会泄漏到缓存，
 *   调用方必须保持只读纪律，需要改写时替换整个对象。
 */

import type { Content } from '../types';

export interface HistorySegmentCacheEntry {
    messages: Content[];
    lastAccess: number;
    /** 该段估算字节数（JSON 序列化长度，用于字节软上限） */
    estimatedBytes: number;
}

export const HISTORY_SEGMENT_CACHE_DEFAULT_MAX = 32;
/** 字节软上限（默认 64MB）：段数未超限但估算字节超限时同样按 LRU 提前淘汰 */
export const HISTORY_SEGMENT_CACHE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class HistorySegmentCache {
    private readonly entries = new Map<string, HistorySegmentCacheEntry>();
    /** conversationId → 该会话的缓存键集合（写后失效 O(桶大小) 清理，避免全表扫描） */
    private readonly buckets = new Map<string, Set<string>>();
    private totalBytes = 0;

    constructor(
        private readonly maxEntries: number = HISTORY_SEGMENT_CACHE_DEFAULT_MAX,
        private readonly maxBytes: number = HISTORY_SEGMENT_CACHE_DEFAULT_MAX_BYTES
    ) {}

    static buildKey(conversationId: string, segmentFile: string, revision: string | number): string {
        return `${conversationId}::${segmentFile}::${revision}`;
    }

    /** 估算一段消息的字节数（JSON 序列化长度；失败时按 0 计，不阻塞缓存写入） */
    static estimateBytes(messages: ReadonlyArray<Content>): number {
        try {
            return JSON.stringify(messages).length;
        } catch {
            return 0;
        }
    }

    /** 命中返回缓存数组（调用方必须只读；元素浅拷贝由 storage 层负责），未命中返回 null。命中会刷新 LRU 顺序。 */
    get(conversationId: string, segmentFile: string, revision: string | number): Content[] | null {
        if (this.maxEntries <= 0) return null;
        const key = HistorySegmentCache.buildKey(conversationId, segmentFile, revision);
        const entry = this.entries.get(key);
        if (!entry) return null;
        entry.lastAccess = Date.now();
        // Map 迭代序即 LRU 序：命中后重新插入到末尾
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.messages;
    }

    set(conversationId: string, segmentFile: string, revision: string | number, messages: Content[]): void {
        if (this.maxEntries <= 0) return;
        const key = HistorySegmentCache.buildKey(conversationId, segmentFile, revision);
        const previous = this.entries.get(key);
        const estimatedBytes = HistorySegmentCache.estimateBytes(messages);
        if (previous) {
            this.totalBytes -= previous.estimatedBytes;
        }
        const entry: HistorySegmentCacheEntry = { messages, lastAccess: Date.now(), estimatedBytes };
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.totalBytes += estimatedBytes;
        // 分桶索引：键属于哪个会话（写后失效按会话 O(桶大小) 清理）
        let bucket = this.buckets.get(conversationId);
        if (!bucket) {
            bucket = new Set();
            this.buckets.set(conversationId, bucket);
        }
        bucket.add(key);
        this.evictIfNeeded();
    }

    /** 写后失效 / 删除会话清理：清除该会话的全部段缓存（按分桶 O(桶大小)，不做全表扫描） */
    invalidateConversation(conversationId: string): void {
        const bucket = this.buckets.get(conversationId);
        if (!bucket) return;
        for (const key of bucket) {
            const entry = this.entries.get(key);
            if (entry) {
                this.entries.delete(key);
                this.totalBytes -= entry.estimatedBytes;
            }
        }
        this.buckets.delete(conversationId);
    }

    clear(): void {
        this.entries.clear();
        this.buckets.clear();
        this.totalBytes = 0;
    }

    get size(): number {
        return this.entries.size;
    }

    /** 当前全部缓存段的估算字节数（诊断/测试） */
    get estimatedBytes(): number {
        return this.totalBytes;
    }

    private evictIfNeeded(): void {
        while (this.entries.size > this.maxEntries
            || (this.totalBytes > this.maxBytes && this.entries.size > 0)) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) break;
            this.removeKey(oldestKey);
        }
    }

    /** 删除一个键并同步维护字节总数与分桶索引（LRU 淘汰共用） */
    private removeKey(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.totalBytes -= entry.estimatedBytes;
        const sep = key.indexOf('::');
        if (sep !== -1) {
            const conversationId = key.slice(0, sep);
            const bucket = this.buckets.get(conversationId);
            if (bucket) {
                bucket.delete(key);
                if (bucket.size === 0) {
                    this.buckets.delete(conversationId);
                }
            }
        }
    }
}
