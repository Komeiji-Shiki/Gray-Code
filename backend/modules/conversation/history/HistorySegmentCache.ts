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
 *   mtime 纳入缓存键（M5，命中前 stat 比对），mtime 变化 → 不同键 → 缓存失效重读；
 * - 内存上限默认 32 段，超过上限按 LRU 淘汰（Map 插入序 + 命中刷新）；
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
}

export const HISTORY_SEGMENT_CACHE_DEFAULT_MAX = 32;

export class HistorySegmentCache {
    private readonly entries = new Map<string, HistorySegmentCacheEntry>();

    constructor(private readonly maxEntries: number = HISTORY_SEGMENT_CACHE_DEFAULT_MAX) {}

    static buildKey(conversationId: string, segmentFile: string, revision: string | number): string {
        return `${conversationId}::${segmentFile}::${revision}`;
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
        const entry: HistorySegmentCacheEntry = { messages, lastAccess: Date.now() };
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.evictIfNeeded();
    }

    /** 写后失效 / 删除会话清理：清除该会话的全部段缓存 */
    invalidateConversation(conversationId: string): void {
        const prefix = `${conversationId}::`;
        for (const key of Array.from(this.entries.keys())) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
            }
        }
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }

    private evictIfNeeded(): void {
        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) break;
            this.entries.delete(oldestKey);
        }
    }
}
