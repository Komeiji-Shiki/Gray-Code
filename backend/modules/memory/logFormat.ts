/**
 * GrayCode - Memory 记录格式工具
 *
 * LOG/TREE 固定宽度记录的编码、解析与容量校验工具。
 * 从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

import { LOG_REC, type LogEntry, type MemoryConfig } from './types';

export function die(msg: string): never {
    throw new Error(msg);
}

export function plural(n: number, word: string): string {
    if (n === 1) return `1 ${word}`;
    if (word.endsWith('y')) return `${n} ${word.slice(0, -1)}ies`;
    if (word.endsWith('s') || word.endsWith('h') || word.endsWith('x')) return `${n} ${word}es`;
    return `${n} ${word}s`;
}

/** 将文本填充为固定宽度记录（含换行符） */
export function pad(text: string, rec: number): Buffer {
    const b = Buffer.from(text, 'utf-8');
    if (b.length > rec - 1) {
        die(`Too long: ${b.length} bytes. The record holds ${rec - 1}.`);
    }
    const buf = Buffer.alloc(rec);
    b.copy(buf);
    buf.fill(0x20, b.length, rec - 1); // 空格填充
    buf[rec - 1] = 0x0a; // 换行符
    return buf;
}

/** 解析一行日志记录；损坏行（无空格头部/非数字 id）返回 null，由调用方跳过 */
export function parse(line: string): LogEntry | null {
    // 格式: "#id date text"
    const headEnd = line.indexOf(' ');
    // B-9: 无空格（headEnd=-1）或 "#" 后无内容时 substring 参数倒置会产生错误切片、
    // parseInt 产出 NaN id 并向 wake/recall 传播——损坏行标记为不可解析。
    if (headEnd <= 1) {
        return null;
    }
    const id = parseInt(line.substring(1, headEnd), 10);
    if (Number.isNaN(id)) {
        return null;
    }
    const rest = line.substring(headEnd + 1);
    const dateEnd = rest.indexOf(' ');
    // 缺 text 的损坏行（"#id date"）dateEnd=-1 时 substring 参数倒置会把整行
    // 既当 date 又当 text 静默错解析——返回 null 由调用方跳过（与无空格头部同口径）。
    if (dateEnd < 0) {
        return null;
    }
    const date = rest.substring(0, dateEnd);
    const text = rest.substring(dateEnd + 1);
    return { id, date, text };
}

/**
 * 固定宽度记录头部 "#<id> <date> " 的最大字节开销：
 * "#"(1) + id(最多 10 位) + " "(1) + date(ISO 日期恒 10 位) + " "(1) = 23。
 * id 超过 10 位（99 亿+ 条记忆）时 assertRecordFits 仍会精确兜底。
 */
export const MAX_HEADER_BYTES = 1 + 10 + 1 + 10 + 1;

/**
 * 旧版 LOG 固定宽度记录大小（迁移前的 LOG_REC=320）。
 * 旧格式文件（320B/条）在打开时由 repairLog 无损迁移到新格式（LOG_REC=1024B/条）；
 * 迁移判定依赖该常量，勿与 LOG_REC 混淆。
 */
export const OLD_LOG_REC = 320;

/**
 * zoom 钳制后半区非 2 幂宽度时降级为原始条目的最大宽度上限：
 * 压缩只写 2 幂对齐块，钳制产生的非 2 幂区间（旧 blockId 越过当前 T）永远不可能
 * 作为整体被压缩，treeGet 必 null；宽度 ≤ 上限时直接 logSlice 展示真实条目。
 * 上限用于防御人工构造的超大 blockId（避免一次性分配 width × LOG_REC 的超大缓冲），
 * 超过上限仍回退摘要占位（与改造前行为一致）。
 */
export const ZOOM_RAW_FALLBACK_MAX = 4096;

/** 记录日期字段必须是 ISO 格式（YYYY-MM-DD），用于旧/新格式内容判别 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验「#id date text」整条固定宽度记录可容纳。
 *
 * 固定宽度记录为 LOG_REC 字节，头部 "#<id> <date> " 随 id 位数增长（约 13~23 字节）。
 * 若只按文本长度（entryChars）校验，用户在把 entryChars 调高或 id 位数增长后
 * 会在 pad() 处以晦涩的 "Too long" 报错。此处按实际 id 精确计算可用文本预算。
 */
export function assertRecordFits(id: number, date: string, text: string, rec: number = LOG_REC): void {
    const overhead = 1 + String(id).length + 1 + date.length + 1;
    const used = overhead + Buffer.byteLength(text, 'utf-8');
    if (used > rec - 1) {
        die(`Too long: text takes ${used - overhead} bytes, budget ${rec - 1 - overhead} bytes ` +
            `(fixed-width record holds ${rec - 1}, header takes ${overhead}).`);
    }
}

/** 从字节缓冲区解析多条记录；rec 为当前记录宽度（新格式 1024，旧格式降级 320） */
export function records(buf: Buffer, rec: number = LOG_REC): LogEntry[] {
    const out: LogEntry[] = [];
    // 只解析完整记录：崩溃残留的尾部半条记录（长度不是 rec 的整数倍）
    // 会被忽略而不是解析成垃圾条目——修复发生在下一次追加（repair），
    // 但修复前的 wake/recall/listEntries 不应把撕裂的尾巴当作有效记忆。
    for (let i = 0; i + rec <= buf.length; i += rec) {
        const slice = buf.subarray(i, i + rec);
        const str = slice.toString('utf-8').trimEnd();
        if (str) {
            // B-9: 损坏行（无空格头部/非数字 id）跳过，不让 NaN id 伪记录进入 wake/recall
            const entry = parse(str);
            if (entry) {
                out.push(entry);
            }
        }
    }
    return out;
}

/**
 * 各配置项的合法范围（与固定宽度记录/分页逻辑配套）：
 * - entryChars 上限须留出 "#<id> <date> " 记录头部空间（MAX_HEADER_BYTES），否则
 *   note/updateEntry 会在 assertRecordFits/pad 处抛 Too long——上限取
 *   LOG_REC - 1 - MAX_HEADER_BYTES（id 增长到 10 位仍有余量），runtime 层仍有精确校验兜底；
 * - 其余项要求为正整数，避免 0/负数导致分页、cover 或 recall 窗口行为异常。
 */
export const MEMORY_CONFIG_BOUNDS: Array<[keyof MemoryConfig, number, number]> = [
    ['wakeLines', 1, 10000],
    ['entryChars', 1, LOG_REC - 1 - MAX_HEADER_BYTES],
    ['partChars', 1, 1000000],
    ['partLines', 1, 100000],
];
