/**
 * GrayCode - Memory 记录格式工具
 *
 * LOG/TREE 固定宽度记录的编码、解析与容量校验工具。
 * 从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

import { LOG_REC, TREE_REC, type LogEntry, type MemoryConfig } from './types';

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
 * 单条记忆文本的字节上限（entryChars 的配置上限）：
 * LOG_REC - 1 - MAX_HEADER_BYTES——留出整条固定宽度记录里头部开销最坏情况
 *（id 增加到 10 位）的空间；runtime 层仍有按真实 id 的精确校验兜底。
 */
export const MAX_ENTRY_CHARS = LOG_REC - 1 - MAX_HEADER_BYTES;

/**
 * 单行树摘要的字节上限：TREE_REC - 1（固定宽度记录的可用正文空间）。
 * compress 的实际预算取 min(entryChars, MAX_TREE_SUMMARY_BYTES)。
 */
export const MAX_TREE_SUMMARY_BYTES = TREE_REC - 1;

/**
 * 早期 LOG 固定宽度记录大小（LOG_REC=320 时代的格式）。
 * 旧格式文件在打开时由 repairLog 按宽度阶梯无损迁移到当前格式；
 * 迁移判定依赖该常量，勿与 LOG_REC 混淆。
 */
export const OLD_LOG_REC = 320;

/**
 * 上一代 LOG 固定宽度记录大小（LOG_REC=1024 时代的格式）。
 * 与 OLD_LOG_REC 一起构成迁移探测的候选宽度（LEGACY_LOG_RECS）。
 */
export const LEGACY_LOG_REC = 1024;

/**
 * 迁移探测的候选旧 LOG 宽度，顺序必须「从旧到新」（内容匹配者胜）：
 * 越旧的宽度越先探测，避免较新宽度把更老格式的文件误判（320 与 1024 的
 * 最小公倍数 5120 使两宽度可能同时整除同一文件，必须靠内容判别定序）。
 */
export const LEGACY_LOG_RECS: readonly number[] = [OLD_LOG_REC, LEGACY_LOG_REC];

/**
 * 旧版 TREE 摘要固定宽度（TREE_REC=288 时代的格式）。
 * 旧 TREE 文件（288B/条）在首次访问时由 MemoryLogStore 无损迁移到 TREE_REC。
 */
export const LEGACY_TREE_REC = 288;

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
 * 树摘要槽位内容是否有效：非空、单行、无 \0。
 *
 * 为什么需要：TREE 记录宽度从 288 升级到 1024 后，未被迁移的旧文件（或迁移失败的
 * 损坏文件）按新宽度读取会把多条记录拼进一个槽位——拼接结果内部必然含记录尾换行，
 * 据此判为无效摘要（返回 null / 视为空槽），触发重新压缩而不是展示乱码。
 */
export function isValidTreeSummary(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.includes('\n') || trimmed.includes('\r')) return false;
    if (trimmed.includes('\0')) return false;
    return true;
}

/**
 * 定宽记录切片是否构成一条合法记录（TREE 迁移的格式判别用）：
 * 以换行结尾、正文可无损往返解码（多字节字符被切断的错位切片会往返不等）、
 * 正文为单行（空槽是全空格 + 换行，同样合法）。
 */
export function isValidTreeRecord(slice: Buffer): boolean {
    if (slice.length === 0 || slice[slice.length - 1] !== 0x0a) return false;
    const body = slice.subarray(0, slice.length - 1);
    const text = body.toString('utf-8');
    if (!Buffer.from(text, 'utf-8').equals(body)) return false;
    if (text.includes('\0')) return false;
    const trimmed = text.trim();
    return !trimmed.includes('\n') && !trimmed.includes('\r');
}

/**
 * 判定文件头是否为「指定宽度的连续记录」：前两条必须是合法记录（id 0/1 + ISO 日期）。
 *
 * 供两处旧宽度探测共用，避免修复路径（MemoryLogStore）与只读导入器
 *（apps/server 的 LegacyMemoryImporter）的判定口径漂移：当前宽度文件的第二个
 * 旧宽度切片必然落在第一条记录内部，解析失败，因此歧义尺寸（如 320 与 1024 的
 * 公倍数 5120、1024 与 4096 的公倍数 4096）无需额外判别。
 */
export function logHeaderLooksLike(buffer: Buffer, rec: number): boolean {
    if (buffer.length < rec * 2) return false;
    const first = parse(buffer.subarray(0, rec).toString('utf-8').trimEnd());
    const second = parse(buffer.subarray(rec, rec * 2).toString('utf-8').trimEnd());
    return !!first && first.id === 0 && ISO_DATE_RE.test(first.date)
        && !!second && second.id === 1 && ISO_DATE_RE.test(second.date);
}

/**
 * 校验「#id date text」整条固定宽度记录可容纳。
 *
 * 固定宽度记录为 rec 字节，头部 "#<id> <date> " 随 id 位数增长（约 13~23 字节）。
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

/** 从字节缓冲区解析多条记录；rec 为当前记录宽度（当前 LOG_REC，降级时可为旧宽度） */
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
 * - entryChars 上限为 MAX_ENTRY_CHARS（LOG_REC - 1 - MAX_HEADER_BYTES = 4072），
 *   否则 note/updateEntry 会在 assertRecordFits/pad 处抛 Too long；
 *   runtime 层仍有按真实 id 的精确校验兜底；
 * - 其余项要求为正整数，避免 0/负数导致分页、cover 或 recall 窗口行为异常。
 */
export const MEMORY_CONFIG_BOUNDS: Array<[keyof MemoryConfig, number, number]> = [
    ['wakeLines', 1, 10000],
    ['entryChars', 1, MAX_ENTRY_CHARS],
    ['partChars', 1, 1000000],
    ['partLines', 1, 100000],
];
