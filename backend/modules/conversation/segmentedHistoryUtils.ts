/**
 * 分段历史索引与文件系统纯工具函数（拆分自 storage.ts 的 FileSystemStorageAdapter）。
 *
 * 这些函数不依赖 VS Code 实例状态，仅做索引校验、分页区间、错误识别与并发限流等纯计算，
 * 供 FileSystemStorageAdapter 的读写路径复用。
 */

import type { ConversationHistory } from './types';
import type { StorageReadResult } from './storageTypes';

/**
 * readDirectory 返回的 [name, type] 中 type 的取值（vscode.FileType 枚举值）。
 * 用符号常量代替魔法数字 1/2，避免与其它文件类型混淆。
 */
export const FS_ENTRY_TYPE_FILE = 1;
export const FS_ENTRY_TYPE_DIRECTORY = 2;

export interface FileHistorySegmentIndexEntry {
    file: string;
    startIndex: number;
    endIndex: number;
    count: number;
}

export interface FileHistoryIndex {
    version: 1;
    segmentSize: number;
    totalMessages: number;
    segments: FileHistorySegmentIndexEntry[];
}

export function isNotFoundError(error: any): boolean {
    const code = String(error?.code || '');
    if (code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT') {
        return true;
    }
    const name = String(error?.name || '');
    if (name.includes('EntryNotFound')) {
        return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return (
        message.includes('entrynotfound') ||
        message.includes('enoent') ||
        message.includes('file not found')
    );
}

/**
 * legacy 历史解析结果校验：ConversationHistory 必须是数组。非数组 JSON（对象/标量，
 * 手工编辑或旧版误写）视为不可读并返回 parse_error，避免读取路径对非数组调用
 * .length/.filter 抛 TypeError（与 getHistoryIndexInfo 误报可读同源的问题）。
 */
export function asHistoryReadResult(result: StorageReadResult<ConversationHistory>): StorageReadResult<ConversationHistory> {
    if (result.value !== null && !Array.isArray(result.value)) {
        return {
            value: null,
            errorCode: 'parse_error',
            errorMessage: 'Legacy history JSON is not an array; refusing to read as conversation history',
        };
    }
    return result;
}

export function buildPageRange(total: number, options: { beforeIndex?: number; offset?: number; limit?: number }) {
    const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
    let startIndex = 0;
    let endExclusive = total;

    if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
        endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
        startIndex = Math.max(0, endExclusive - limit);
    } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
        startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
        endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
    } else {
        startIndex = Math.max(0, total - limit);
        endExclusive = total;
    }

    return { startIndex, endExclusive };
}

/**
 * 缓存 revision：任何历史提交都会改变 totalMessages 或段结构；把段结构（文件/区间/计数）
 * 一并纳入 revision——FAT 2s 粒度下 totalMessages 未变但段被重排/重切时也能失效缓存
 * （同尺寸段内原地编辑的极端边界仍由 readSegmentCached 的 mtime+size 双键兜底）。
 */
export function buildSegmentCacheRevision(index: FileHistoryIndex): string {
    return `${index.totalMessages}:${index.segments.map(s => `${s.file}:${s.startIndex}:${s.count}`).join('|')}`;
}

/**
 * 限流并发执行（HIS-05）：同时最多 concurrency 个任务在途，结果按输入顺序返回。
 */
export async function runBounded<T, R>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }));
    return results;
}

/** 两个 index 版本是否指向同一批段文件（totalMessages + 段标识逐一比对） */
export function sameIndexVersion(a: FileHistoryIndex, b: FileHistoryIndex): boolean {
    if (a.totalMessages !== b.totalMessages) return false;
    if (a.segments.length !== b.segments.length) return false;
    for (let i = 0; i < a.segments.length; i++) {
        const sa = a.segments[i];
        const sb = b.segments[i];
        if (!sa || !sb) return false;
        if (sa.file !== sb.file || sa.startIndex !== sb.startIndex
            || sa.endIndex !== sb.endIndex || sa.count !== sb.count) {
            return false;
        }
    }
    return true;
}

/**
 * 校验 index 内部一致性：Σsegments.count === totalMessages 且段区间连续不重叠。
 * 只做内存计算（不读段文件），读路径在索引解析后立即调用；返回错误描述，一致时返回 null。
 */
export function validateIndexConsistency(index: FileHistoryIndex): string | null {
    let sum = 0;
    for (let i = 0; i < index.segments.length; i++) {
        const segment = index.segments[i];
        if (!segment || !Number.isFinite(segment.count) || segment.count < 0
            || !Number.isFinite(segment.startIndex) || !Number.isFinite(segment.endIndex)) {
            return `History index segment ${segment?.file ?? i} has invalid range`;
        }
        if (segment.endIndex !== segment.startIndex + segment.count - 1) {
            return `History index segment ${segment.file} endIndex(${segment.endIndex}) `
                + `!== startIndex+count-1(${segment.startIndex + segment.count - 1})`;
        }
        if (i > 0) {
            const prev = index.segments[i - 1];
            if (segment.startIndex !== prev.startIndex + prev.count) {
                return `History index segments not contiguous: ${prev.file} -> ${segment.file}`;
            }
        }
        sum += segment.count;
    }
    if (sum !== index.totalMessages) {
        return `History index inconsistent: Σsegments.count(${sum}) !== totalMessages(${index.totalMessages})`;
    }
    return null;
}
