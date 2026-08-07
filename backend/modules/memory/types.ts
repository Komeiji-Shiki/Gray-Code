/**
 * LimCode - Memory 模块类型定义
 *
 * OptMem 风格的永久记忆系统：追加式日志 + 二叉树摘要
 */

/** 长期记忆工具名称 */
export const MEMORY_TOOL_NAMES = [
    'memory_wake',
    'memory_note',
    'memory_recall',
    'memory_compress',
    'memory_zoom',
    'memory_forget',
    'memory_config',
] as const;

const MEMORY_TOOL_NAME_SET = new Set<string>(MEMORY_TOOL_NAMES);

export function isMemoryToolName(toolName: string): boolean {
    return MEMORY_TOOL_NAME_SET.has(toolName);
}

/** 单条日志记录 */
export interface LogEntry {
    /** 记录 ID（在 LOG 中的序号） */
    id: number;
    /** 日期，ISO 格式 YYYY-MM-DD */
    date: string;
    /** 记忆文本 */
    text: string;
}

/** wake 输出中的一个块 */
export interface WakeBlock {
    /** 起始 ID（包含） */
    lo: number;
    /** 结束 ID（包含，如果是原始记忆则 lo === hi） */
    hi: number;
    /** 块内容（原始记忆文本或摘要文本） */
    text: string;
    /** 是否为原始记忆（非摘要） */
    isRaw: boolean;
}

/** wake 的结果 */
export interface WakeResult {
    /** 唤醒到的块列表（一次输出全部可用记忆） */
    blocks: WakeBlock[];
    /** 总记忆数 */
    totalMemories: number;
    /** 是否已完成唤醒（单次输出后恒为 true） */
    awake: boolean;
    /** 待处理的压缩提示（如果有） */
    pendingCompression?: NapPrompt;
}

/** note 的结果 */
export interface NoteResult {
    /** 分配的 ID */
    id: number;
    /** 待处理的压缩提示（如果有） */
    pendingCompression?: NapPrompt;
}

/** recall 的结果 */
export interface RecallResult {
    /** 匹配的行列表 */
    lines: string[];
    /** 总命中数 */
    totalHits: number;
    /** 是否被截断 */
    truncated: boolean;
}

/** compress (nap) 的结果 */
export interface CompressResult {
    /** 已完成的压缩数 */
    done: number;
    /** 下一个待处理的压缩提示（如果有） */
    pendingCompression?: NapPrompt;
}

/** zoom 的结果 */
export interface ZoomResult {
    /** 左半部分 */
    left: WakeBlock;
    /** 右半部分 */
    right: WakeBlock;
}

/** 压缩提示 */
export interface NapPrompt {
    /** 要压缩的块 ID 字符串（如 "0-1"） */
    blockId: string;
    /** lo */
    lo: number;
    /** hi（不包含） */
    hi: number;
    /** 提示文本 */
    prompt: string;
    /** 剩余待压缩数量 */
    remaining: number;
}

/** 记忆配置 */
export interface MemoryConfig {
    /** WAKE_LINES: wake 输出的最大行数 */
    wakeLines: number;
    /** ENTRY_CHARS: 单条记忆最大字节数 */
    entryChars: number;
}

/** 默认配置 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    wakeLines: 96,
    entryChars: 280,
};

/** 固定宽度记录大小 */
export const LOG_REC = 320;
export const TREE_REC = 288;

/** 最多直接从原始日志压缩的记忆条数 */
export const RAW_MAX = 16;
