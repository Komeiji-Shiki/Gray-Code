/**
 * GrayCode - Prompt 固定文件读取预算与缓存
 *
 * 固定文件内容读取的 TTL 缓存、大小/累计字节预算与 PinnedFile 归一化。
 * 从 PromptManager.ts 抽离（纯重构，行为不变）。
 *
 * 调用链 getPromptContextBundle -> getLegacyDynamicContextMessages -> buildDynamicPromptModules
 * -> generatePinnedFilesSection 全部为同步签名（ToolIterationLoopService / ContextTrimService /
 * SettingsHandler 在同步位置调用），无法直接异步化，因此采用「TTL 缓存 + mtime 失效 + 大小限制」
 * 的最小同步方案：
 * - TTL 内零磁盘 I/O（不 stat、不 read）
 * - TTL 过期后仅 stat 校验 mtime，未变更则复用缓存内容，变更才重读
 * - 单文件超过 PINNED_FILE_MAX_BYTES 只读取前 N 字节并标记截断
 * - 全部固定文件累计读取超过 PINNED_FILE_MAX_TOTAL_BYTES 时跳过剩余文件
 */

import * as fs from 'fs'
import type { PinnedFileItem } from '../settings'

/** 单文件大小上限（字节）：超过则只读取前 N 字节并标记截断 */
export const PINNED_FILE_MAX_BYTES = 1024 * 1024 // 1MB

/** 单次生成累计读取字节上限（字节）：超过则跳过剩余固定文件 */
export const PINNED_FILE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 // 2MB

/** 固定文件内容缓存 TTL（毫秒） */
export const PINNED_FILE_CACHE_TTL_MS = 5000

export interface PinnedFileCacheEntry {
    content: string
    mtimeMs: number
    bytesRead: number
    truncated: boolean
    checkedAt: number
}

/** 固定文件内容缓存：key=绝对路径；TTL + mtime 双失效 */
const pinnedFileCache = new Map<string, PinnedFileCacheEntry>()

/** 固定文件内容缓存条目数上限（超出后按 LRU 淘汰最久未访问条目） */
export const PINNED_FILE_CACHE_MAX_ENTRIES = 32

/** 固定文件内容缓存累计内容字节预算（超出后继续淘汰最久未访问条目直到达标） */
export const PINNED_FILE_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024 // 16MB

export function getPinnedFileCacheEntry(fullPath: string): PinnedFileCacheEntry | undefined {
    return pinnedFileCache.get(fullPath)
}

export function deletePinnedFileCacheEntry(fullPath: string): void {
    pinnedFileCache.delete(fullPath)
}

/**
 * 写入固定文件缓存并执行 LRU 淘汰：
 * - 条目数超过 PINNED_FILE_CACHE_MAX_ENTRIES 时淘汰最久未访问（Map 头部）的条目
 * - 累计内容字节超过 PINNED_FILE_CACHE_MAX_TOTAL_BYTES 时继续淘汰直到达标
 */
export function setPinnedFileCache(fullPath: string, entry: PinnedFileCacheEntry): void {
    pinnedFileCache.delete(fullPath)
    pinnedFileCache.set(fullPath, entry)
    let totalBytes = 0
    for (const [, cached] of pinnedFileCache) {
        totalBytes += cached.bytesRead
    }
    while (
        pinnedFileCache.size > PINNED_FILE_CACHE_MAX_ENTRIES ||
        totalBytes > PINNED_FILE_CACHE_MAX_TOTAL_BYTES
    ) {
        const oldestKey = pinnedFileCache.keys().next().value as string | undefined
        if (oldestKey === undefined) {
            break
        }
        const evicted = pinnedFileCache.get(oldestKey)
        pinnedFileCache.delete(oldestKey)
        if (evicted) {
            totalBytes -= evicted.bytesRead
        }
    }
}

/** 触碰缓存条目刷新 LRU 顺序（移到 Map 尾部 = 最近访问） */
export function touchPinnedFileCache(fullPath: string): void {
    const cached = pinnedFileCache.get(fullPath)
    if (cached) {
        pinnedFileCache.delete(fullPath)
        pinnedFileCache.set(fullPath, cached)
    }
}

/**
 * 读取固定文件内容并应用单文件大小上限：
 * 小文件整体读取；大文件只读取前 PINNED_FILE_MAX_BYTES 字节（不把整文件载入内存）。
 */
export function readPinnedFileCapped(fullPath: string, statSize: number): { content: string; bytesRead: number; truncated: boolean } {
    if (statSize <= PINNED_FILE_MAX_BYTES) {
        const content = fs.readFileSync(fullPath, 'utf-8')
        return { content, bytesRead: statSize, truncated: false }
    }

    const fd = fs.openSync(fullPath, 'r')
    try {
        const buffer = Buffer.alloc(PINNED_FILE_MAX_BYTES)
        const bytesRead = fs.readSync(fd, buffer, 0, PINNED_FILE_MAX_BYTES, 0)
        // 去掉被切断的多字节 UTF-8 字符留下的孤立 U+FFFD
        const content = buffer.subarray(0, bytesRead).toString('utf-8').replace(/[\uFFFD]{1,3}$/, '')
        return { content, bytesRead: Math.min(statSize, PINNED_FILE_MAX_BYTES), truncated: true }
    } finally {
        fs.closeSync(fd)
    }
}

export function normalizePinnedFiles(raw: unknown): PinnedFileItem[] {
    if (!Array.isArray(raw)) return []
    return raw
        .filter((item): item is PinnedFileItem => (
            !!item
            && typeof (item as any).id === 'string'
            && typeof (item as any).path === 'string'
            && typeof (item as any).workspaceUri === 'string'
            && typeof (item as any).enabled === 'boolean'
            && typeof (item as any).addedAt === 'number'
        ))
        .map(item => ({ ...item }))
}
