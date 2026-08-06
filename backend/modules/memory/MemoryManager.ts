/**
 * LimCode - MemoryManager
 *
 * OptMem 风格永久记忆系统的核心引擎。
 * 负责 LOG（追加式日志）和 TREE（二叉树摘要缓存）的读写，
 * 以及 cover 算法、压缩管理等。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    LOG_REC, TREE_REC, RAW_MAX, DEFAULT_MEMORY_CONFIG,
    type LogEntry, type WakeBlock, type WakeResult,
    type NoteResult, type RecallResult, type CompressResult,
    type ZoomResult, type NapPrompt, type MemoryConfig,
} from './types';
import { validateRegexPattern } from '../../tools/search/regexGuard';

// ─── 工具函数 ─────────────────────────────────────────

function die(msg: string): never {
    throw new Error(msg);
}

function plural(n: number, word: string): string {
    if (n === 1) return `1 ${word}`;
    if (word.endsWith('y')) return `${n} ${word.slice(0, -1)}ies`;
    if (word.endsWith('s') || word.endsWith('h') || word.endsWith('x')) return `${n} ${word}es`;
    return `${n} ${word}s`;
}

/** 将文本填充为固定宽度记录（含换行符） */
function pad(text: string, rec: number): Buffer {
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

/** 解析一行日志记录 */
function parse(line: string): LogEntry {
    // 格式: "#id date text"
    const headEnd = line.indexOf(' ');
    const id = parseInt(line.substring(1, headEnd), 10);
    const rest = line.substring(headEnd + 1);
    const dateEnd = rest.indexOf(' ');
    const date = rest.substring(0, dateEnd);
    const text = rest.substring(dateEnd + 1);
    return { id, date, text };
}

/**
 * 固定宽度记录头部 "#<id> <date> " 的最大字节开销：
 * "#"(1) + id(最多 10 位) + " "(1) + date(ISO 日期恒 10 位) + " "(1) = 23。
 * id 超过 10 位（99 亿+ 条记忆）时 assertRecordFits 仍会精确兜底。
 */
const MAX_HEADER_BYTES = 1 + 10 + 1 + 10 + 1;

/**
 * 校验「#id date text」整条固定宽度记录可容纳。
 *
 * 固定宽度记录为 LOG_REC 字节，头部 "#<id> <date> " 随 id 位数增长（约 13~23 字节）。
 * 若只按文本长度（entryChars）校验，用户在把 entryChars 调高或 id 位数增长后
 * 会在 pad() 处以晦涩的 "Too long" 报错。此处按实际 id 精确计算可用文本预算。
 */
function assertRecordFits(id: number, date: string, text: string): void {
    const overhead = 1 + String(id).length + 1 + date.length + 1;
    const used = overhead + Buffer.byteLength(text, 'utf-8');
    if (used > LOG_REC - 1) {
        die(`Too long: text takes ${used - overhead} bytes, budget ${LOG_REC - 1 - overhead} bytes ` +
            `(fixed-width record holds ${LOG_REC - 1}, header takes ${overhead}).`);
    }
}

/** 从字节缓冲区解析多条记录 */
function records(buf: Buffer): LogEntry[] {
    const out: LogEntry[] = [];
    // 只解析完整记录：崩溃残留的尾部半条记录（长度不是 LOG_REC 的整数倍）
    // 会被忽略而不是解析成垃圾条目——修复发生在下一次追加（repair），
    // 但修复前的 wake/recall/listEntries 不应把撕裂的尾巴当作有效记忆。
    for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
        const slice = buf.subarray(i, i + LOG_REC);
        const str = slice.toString('utf-8').trimEnd();
        if (str) {
            out.push(parse(str));
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
const MEMORY_CONFIG_BOUNDS: Array<[keyof MemoryConfig, number, number]> = [
    ['wakeLines', 1, 10000],
    ['entryChars', 1, LOG_REC - 1 - MAX_HEADER_BYTES],
    ['partChars', 1, 1000000],
    ['partLines', 1, 100000],
];

// ─── 异步锁（保证操作串行化） ─────────────────────

class AsyncLock {
    private _chain: Promise<void> = Promise.resolve();

    async acquire(): Promise<() => void> {
        let release!: () => void;
        const next = new Promise<void>(r => { release = r; });
        const prev = this._chain;
        this._chain = prev.then(() => next);
        await prev;
        return release;
    }
}

// ─── MemoryManager ──────────────────────────────────

export class MemoryManager {
    private dir: string;
    private config: MemoryConfig;
    private lock = new AsyncLock();

    constructor(storagePath: string, config?: Partial<MemoryConfig>) {
        this.dir = storagePath;
        this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    }

    /** 初始化存储目录结构 */
    async init(): Promise<void> {
        await fs.mkdir(path.join(this.dir, 'TREE'), { recursive: true });
        const logPath = this.logPath();
        try {
            await fs.access(logPath);
        } catch {
            await fs.writeFile(logPath, '');
        }
        // 写入默认 config（如果不存在）
        const configPath = path.join(this.dir, 'config');
        try {
            await fs.access(configPath);
        } catch {
            await this.writeConfig(this.config);
        }
    }

    /** 检查存储是否已初始化 */
    async isInitialized(): Promise<boolean> {
        try {
            await fs.access(this.logPath());
            return true;
        } catch {
            return false;
        }
    }

    // ─── 路径工具 ──────────────────────────────

    private logPath(): string {
        return path.join(this.dir, 'LOG.txt');
    }

    private treePath(size: number): string {
        return path.join(this.dir, 'TREE', String(size));
    }

    // ─── 底层读写 ──────────────────────────────

    /** 修复部分写入的尾部记录（crash recovery） */
    private async repair(filePath: string, rec: number): Promise<void> {
        try {
            const stat = await fs.stat(filePath);
            if (stat.size % rec !== 0) {
                const handle = await fs.open(filePath, 'r+');
                try {
                    await handle.truncate(stat.size - (stat.size % rec));
                } finally {
                    await handle.close();
                }
            }
        } catch {
            // 文件不存在，忽略
        }
    }

    /** 获取记录数量 */
    private async count(filePath: string, rec: number): Promise<number> {
        try {
            const stat = await fs.stat(filePath);
            return Math.floor(stat.size / rec);
        } catch (e: any) {
            // 只有「文件不存在」视为空；其余 IO 错误应上抛而不是静默当作 0 条，
            // 否则 wake 会在文件实际不可读时谎报「没有记忆」。
            if (e?.code !== 'ENOENT') throw e;
            return 0;
        }
    }

    private async logLen(): Promise<number> {
        return this.count(this.logPath(), LOG_REC);
    }

    /** 追加日志记录，返回起始 ID */
    private async logAppend(items: Array<{ date: string; text: string }>): Promise<number> {
        const release = await this.lock.acquire();
        try {
            await this.repair(this.logPath(), LOG_REC);
            const base = await this.logLen();
            const chunks: Buffer[] = [];
            for (let k = 0; k < items.length; k++) {
                const { date, text } = items[k];
                // 锁内用真实分配的 id 精确校验整条记录容量（含 "#<id> <date> " 头部开销）：
                // id 由本方法在锁内分配，此处校验与实际写入完全一致，不存在估算竞态
                // （锁外按 logLen 估算可能低估 id 位数，并发追加时仍会在 pad() 抛晦涩 Too long）。
                assertRecordFits(base + k, date, text);
                chunks.push(pad(`#${base + k} ${date} ${text}`, LOG_REC));
            }
            await fs.appendFile(this.logPath(), Buffer.concat(chunks));
            return base;
        } finally {
            release();
        }
    }

    /** 读取指定范围的日志记录 */
    private async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
        const handle = await fs.open(this.logPath(), 'r');
        try {
            const buf = Buffer.alloc((hi - lo) * LOG_REC);
            const { bytesRead } = await handle.read(buf, 0, buf.length, lo * LOG_REC);
            if (bytesRead < buf.length) {
                // 记录不足，截取实际读取的部分
                return records(buf.subarray(0, bytesRead));
            }
            return records(buf);
        } finally {
            await handle.close();
        }
    }

    /** 读取单条日志 */
    private async logGet(i: number): Promise<LogEntry> {
        const entries = await this.logSlice(i, i + 1);
        if (entries.length === 0) die(`No memory at index ${i}`);
        return entries[0];
    }

    /** 流式扫描全部日志 */
    private async *logScan(): AsyncGenerator<LogEntry> {
        let handle: import('fs').promises.FileHandle | null = null;
        try {
            handle = await fs.open(this.logPath(), 'r');
            let offset = 0;
            while (true) {
                const buf = Buffer.alloc(LOG_REC * 4096);
                const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
                if (bytesRead === 0) break;
                const entries = records(buf.subarray(0, bytesRead));
                for (const e of entries) yield e;
                offset += bytesRead;
            }
        } catch (e: any) {
            // 日志不存在视为空扫描；其余 IO 错误上抛（与 count 同口径）
            if (e?.code !== 'ENOENT') throw e;
        } finally {
            if (handle) await handle.close();
        }
    }

    /** 读取树摘要 */
    private async treeGet(lo: number, hi: number): Promise<string | null> {
        const size = hi - lo;
        try {
            const handle = await fs.open(this.treePath(size), 'r');
            try {
                const buf = Buffer.alloc(TREE_REC);
                const { bytesRead } = await handle.read(buf, 0, TREE_REC, (lo / size) * TREE_REC);
                if (bytesRead < TREE_REC) return null;
                const str = buf.toString('utf-8').trimEnd();
                return str || null;
            } finally {
                await handle.close();
            }
        } catch {
            return null;
        }
    }

    /** 写入树摘要 */
    private async treePut(lo: number, hi: number, text: string): Promise<boolean> {
        const size = hi - lo;
        const release = await this.lock.acquire();
        try {
            const p = this.treePath(size);
            await this.repair(p, TREE_REC);
            const n = await this.count(p, TREE_REC);
            if (n !== lo / size) return false;
            await fs.appendFile(p, pad(text, TREE_REC));
            return true;
        } finally {
            release();
        }
    }

    /** 丢弃树摘要及其上层 */
    async treeDrop(lo: number, hi: number): Promise<Array<[number, number]>> {
        const gone: Array<[number, number]> = [];
        let size = hi - lo;
        const release = await this.lock.acquire();
        try {
            const T = await this.logLen();
            while (size <= T) {
                const p = this.treePath(size);
                const k = Math.floor(lo / size);
                const n = await this.count(p, TREE_REC);
                if (n > k) {
                    for (let i = k; i < n; i++) {
                        gone.push([i * size, (i + 1) * size]);
                    }
                    const handle = await fs.open(p, 'r+');
                    try {
                        await handle.truncate(k * TREE_REC);
                    } finally {
                        await handle.close();
                    }
                }
                size *= 2;
            }
            return gone;
        } finally {
            release();
        }
    }

    // ─── cover 算法 ─────────────────────────────

    /**
     * 用对齐的 2 的幂次方块覆盖 [0, T)。
     * alpha 越大 => 越粗糙 => 越少的行。
     */
    private _cover(T: number, alpha: number): Array<[number, number]> {
        let root = 1;
        while (root < T) root *= 2;
        const out: Array<[number, number]> = [];
        const stack: Array<[number, number]> = [[0, root]];
        while (stack.length > 0) {
            const [lo, hi] = stack.pop()!;
            if (lo >= T) continue;
            const size = hi - lo;
            if (size > 1 && (hi > T || size > alpha * (T - lo))) {
                const mid = (lo + hi) >> 1;
                stack.push([mid, hi]);
                stack.push([lo, mid]);
            } else {
                out.push([lo, hi]);
            }
        }
        out.sort((a, b) => a[0] - b[0]);
        return out;
    }

    /**
     * 生成 wake 应该展示的块列表。
     * 最多 `budget` 个块，细节向现在递增。
     */
    cover(T: number, budget: number): Array<[number, number]> {
        if (T <= 0) return [];
        if (T <= budget) {
            return Array.from({ length: T }, (_, i) => [i, i + 1] as [number, number]);
        }
        let lo = 0.0, hi = 1.0;
        // 32 次迭代即可把区间缩到 < 1e-9（60 次对阈值精度无增益，却多付约一倍 _cover 开销）；
        // 每次 _cover 最坏 O(块数)，记忆量大时浪费明显，区间足够窄时提前退出。
        for (let i = 0; i < 32; i++) {
            if (hi - lo < 1e-9) break;
            const mid = (lo + hi) / 2;
            if (this._cover(T, mid).length > budget) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const out = this._cover(T, hi);
        // 用尽剩余预算：拆分最大的块
        const result = [...out];
        while (result.length < budget) {
            let bestIdx = -1, bestSize = 0;
            for (let i = 0; i < result.length; i++) {
                const s = result[i][1] - result[i][0];
                if (s > bestSize) {
                    bestSize = s;
                    bestIdx = i;
                }
            }
            if (bestIdx < 0 || bestSize <= 1) break;
            const [l, h] = result[bestIdx];
            const m = (l + h) >> 1;
            result.splice(bestIdx, 1, [l, m], [m, h]);
        }
        return result;
    }

    // ─── 压缩管理 ──────────────────────────────

    /** 列出所有待构建的块（最小优先） */
    async pending(T: number, limit?: number): Promise<Array<[number, number]>> {
        const todo: Array<[number, number]> = [];
        let size = 2;
        while (size <= T) {
            const have = await this.count(this.treePath(size), TREE_REC);
            const maxK = Math.floor(T / size);
            for (let k = have; k < maxK; k++) {
                todo.push([k * size, (k + 1) * size]);
                if (limit && todo.length >= limit) return todo;
            }
            size *= 2;
        }
        return todo;
    }

    /** 待构建块的数量 */
    async pendingCount(T: number): Promise<number> {
        let n = 0, size = 2;
        while (size <= T) {
            n += Math.max(0, Math.floor(T / size) - await this.count(this.treePath(size), TREE_REC));
            size *= 2;
        }
        return n;
    }

    /** 生成压缩提示 */
    private async napPrompt(lo: number, hi: number, remaining: number): Promise<NapPrompt> {
        let body: string;
        if (hi - lo <= RAW_MAX) {
            const entries = await this.logSlice(lo, hi);
            body = entries.map(e => `  #${e.id} ${e.date} ${e.text}`).join('\n');
        } else {
            const mid = (lo + hi) >> 1;
            const halves: string[] = [];
            for (const [a, b] of [[lo, mid], [mid, hi]] as Array<[number, number]>) {
                const s = await this.treeGet(a, b);
                if (s === null) {
                    die(`The summary of #${a}-${b - 1} is blank. Run: memory_forget ${a}-${b - 1}`);
                }
                halves.push(`  #${a}-${b - 1} ${s}`);
            }
            body = halves.join('\n');
        }
        const tail = remaining === 0 ? '' :
            remaining === 1 ? '\n1 compression remains after this one.' :
            `\n${remaining} compressions remain after this one.`;

        const blockId = `${lo}-${hi - 1}`;
        const prompt = `Compress memories #${lo}-${hi - 1} into one line of at most ${this.config.entryChars} characters.\n` +
            `Keep what has lasting effect, drop what does not. Invent nothing.\n\n${body}${tail}\n` +
            `Run: memory_compress "${blockId}" "<your line>"`;

        return { blockId, lo, hi, prompt, remaining };
    }

    /** 获取下一个待压缩的提示 */
    async nextNap(T: number): Promise<NapPrompt | null> {
        const todo = await this.pending(T, 1);
        if (todo.length === 0) return null;
        const [lo, hi] = todo[0];
        return this.napPrompt(lo, hi, await this.pendingCount(T) - 1);
    }

    // ─── 分页 ──────────────────────────────────

    /** 将行列表按 PART_CHARS / PART_LINES 分页 */
    paginate(lines: string[]): string[][] {
        const parts: string[][] = [];
        let cur: string[] = [];
        let size = 0;
        for (const line of lines) {
            const n = Buffer.byteLength(line, 'utf-8') + 1;
            if (cur.length > 0 && (cur.length >= this.config.partLines || size + n > this.config.partChars)) {
                parts.push(cur);
                cur = [];
                size = 0;
            }
            cur.push(line);
            size += n;
        }
        if (cur.length > 0) parts.push(cur);
        return parts;
    }

    // ─── 公共 API ─────────────────────────────

    /**
     * wake: 读取记忆。
     * @param part 要读取的部分号（1-based），不传则读第 1 部分
     * @param T 快照时的记忆总数（不传则用当前总数）
     */
    async wake(part?: number, T?: number): Promise<WakeResult> {
        const now = await this.logLen();
        const snapshotT = T ?? now;
        if (snapshotT > now) {
            die(`T=${snapshotT}, but the log holds ${plural(now, 'memory')}. Run memory_wake.`);
        }

        if (snapshotT === 0) {
            return {
                blocks: [],
                part: 1,
                totalParts: 1,
                totalMemories: 0,
                awake: true,
            };
        }

        const lines: string[] = [];
        // 连续原始块（cover 输出按 lo 升序）合并为一次 logSlice 读取：
        // 此前逐块 logGet → logSlice 各做一次 open/read/close，记忆量大
        // （T ≤ wakeLines 可达 10000 条）时一次 wake 产生上万次文件句柄循环。
        let runLo = -1;
        let runHi = -1;
        const flushRawRun = async (lo: number, hi: number): Promise<void> => {
            const entries = await this.logSlice(lo, hi);
            if (entries.length !== hi - lo) {
                // 读取期间日志被并发截断/改写：旧实现会在 logGet 处以
                // "No memory at index" 报错，此处保持同等的严格提示。
                die(`The log changed while reading #${lo}-${hi - 1}. Run memory_wake again.`);
            }
            for (const e of entries) {
                lines.push(`#${e.id} ${e.date} ${e.text}`);
            }
        };
        for (const [lo, hi] of this.cover(snapshotT, this.config.wakeLines)) {
            if (hi - lo === 1) {
                if (runLo < 0) runLo = lo;
                runHi = hi;
                continue;
            }
            if (runLo >= 0) {
                await flushRawRun(runLo, runHi);
                runLo = -1;
            }
            let s = await this.treeGet(lo, hi);
            if (s === null) {
                const pc = await this.pendingCount(snapshotT);
                if (pc > 0) {
                    // 直接用实际缺失的块构造提示，而不是 nextNap 返回的
                    // "第一个待压缩块"（可能不是 wake 实际缺失的那个块）。
                    const nap = await this.napPrompt(lo, hi, pc - 1);
                    throw new Error(
                        `Cannot wake: the memory context needs #${lo}-${hi - 1}, ` +
                        `which is not compressed yet.\nDo the ${plural(pc, 'compression')} below, ` +
                        `then run memory_wake again.\n\n${nap.prompt}`
                    );
                }
                s = await this.treeGet(lo, hi); // 并行会话可能已完成
            }
            if (s === null) {
                die(`The summary of #${lo}-${hi - 1} is blank. Run: memory_forget ${lo}-${hi - 1}`);
            }
            lines.push(`#${lo}-${hi - 1} ${s}`);
        }
        if (runLo >= 0) {
            await flushRawRun(runLo, runHi);
        }

        const parts = this.paginate(lines);
        const k = part ?? 1;
        if (k < 1 || k > parts.length) {
            die(`No part ${k}: the memory has ${plural(parts.length, 'part')}. Run memory_wake.`);
        }

        const awake = k >= parts.length;
        const blocks = this.parseWakeBlocks(parts[k - 1]);

        let pendingCompression: NapPrompt | undefined;
        if (awake) {
            const nap = await this.nextNap(snapshotT);
            if (nap) pendingCompression = nap;
        }

        return {
            blocks,
            part: k,
            totalParts: parts.length,
            totalMemories: snapshotT,
            awake,
            pendingCompression,
        };
    }

    /** 解析 wake 输出行转为 WakeBlock[] */
    private parseWakeBlocks(lines: string[]): WakeBlock[] {
        const blocks: WakeBlock[] = [];
        for (const line of lines) {
            const m = line.match(/^#(\d+)(?:-(\d+))?\s(.+)$/);
            if (!m) continue;
            const lo = parseInt(m[1], 10);
            const hi = m[2] ? parseInt(m[2], 10) : lo;
            blocks.push({ lo, hi, text: m[3], isRaw: lo === hi });
        }
        return blocks;
    }

    /**
     * note: 记录一条记忆。
     */
    async note(text: string): Promise<NoteResult> {
        const trimmed = text.trim();
        if (!trimmed) die('Empty. A memory is one line of text.');
        if (trimmed.includes('\n') || trimmed.includes('\r')) {
            die(`${trimmed.split(/\r?\n/).length} lines. A memory is one line.`);
        }
        const byteLen = Buffer.byteLength(trimmed, 'utf-8');
        if (byteLen > this.config.entryChars) {
            die(`Too long: ${byteLen} bytes, limit ${this.config.entryChars}.`);
        }

        const today = new Date().toISOString().slice(0, 10);
        // 整条固定宽度记录容量校验（含头部开销）在 logAppend 锁内按真实 id 执行
        const id = await this.logAppend([{ date: today, text: trimmed }]);

        const nap = await this.nextNap(id + 1);
        return { id, pendingCompression: nap ?? undefined };
    }

    /**
     * recall: 正则搜索全部记忆。
     */
    async recall(regex: string): Promise<RecallResult> {
        // ReDoS 防护：长度上限 + 危险模式检测 + 构造异常捕获（共享 regexGuard）
        const guarded = validateRegexPattern(regex, 'i');
        if (!guarded.ok) {
            die(`bad regex: ${guarded.error}`);
        }
        const pat = guarded.regex;

        // 用 head 指针代替 shift() 淘汰旧匹配：shift 是 O(n)，命中量大时整体退化为 O(n²)。
        // head 记录已被淘汰的窗口起点；淘汰数超过存活数一半时 splice 压缩数组（摊还 O(1)），
        // 数组容量始终约为存活窗口的 2 倍，不会随总命中数无限增长。
        const matches: string[] = [];
        let head = 0;
        let totalHits = 0;
        let size = 0;

        for await (const e of this.logScan()) {
            const line = `#${e.id} ${e.date} ${e.text}`;
            if (!pat.test(line)) continue;
            totalHits++;
            matches.push(line);
            size += Buffer.byteLength(line, 'utf-8') + 1;
            // 保持最新的匹配，丢弃最旧的
            while (size > this.config.partChars && head < matches.length) {
                size -= Buffer.byteLength(matches[head], 'utf-8') + 1;
                head++;
            }
            // 淘汰超过一半时压缩，防止 head 无界增长
            if (head > 0 && head * 2 >= matches.length) {
                matches.splice(0, head);
                head = 0;
            }
        }

        if (totalHits === 0) {
            return { lines: [], totalHits: 0, truncated: false };
        }

        const lines = head === 0 ? matches : matches.slice(head);
        const truncated = lines.length < totalHits;
        return { lines, totalHits, truncated };
    }

    /**
     * compress: 执行压缩合并（OptMem 的 nap）。
     * @param blockId 块 ID（如 "0-1"），不传则自动处理下一个
     * @param summary 压缩后的摘要文本
     */
    async compress(blockId?: string, summary?: string): Promise<CompressResult> {
        const T = await this.logLen();
        let said = false;

        if (blockId && summary !== undefined) {
            const [lo, hi] = this.parseBlockId(blockId);
            const todo = await this.pending(T, 1);
            if (todo.length === 0) {
                return { done: 0 };
            }
            if (lo !== todo[0][0] || hi !== todo[0][1]) {
                const existing = await this.treeGet(lo, hi);
                if (existing === null) {
                    die(`Wrong block: ${blockId}. Blocks are built in order; the next is ` +
                        `${todo[0][0]}-${todo[0][1] - 1}. Run memory_compress.`);
                }
            } else {
                const trimmed = (summary || '').trim();
                if (!trimmed) die('Empty summary.');
                const byteLen = Buffer.byteLength(trimmed, 'utf-8');
                if (byteLen > this.config.entryChars) {
                    die(`Too long: ${byteLen} bytes, limit ${this.config.entryChars}.`);
                }
                const ok = await this.treePut(lo, hi, trimmed);
                if (ok) {
                    // 只有真正写入成功才置 said=true：
                    // 块已存在或 treePut 返回 false（并行会话已处理）时保持 said=false，
                    // 避免上报 done:1 与实际写入不符。
                    said = true;
                }
            }
        }

        const nap = await this.nextNap(T);
        return { done: said ? 1 : 0, pendingCompression: nap ?? undefined };
    }

    /**
     * zoom: 展开树节点查看两半。
     */
    async zoom(blockId: string): Promise<ZoomResult> {
        const [lo, hi] = this.parseBlockId(blockId);
        const T = await this.logLen();
        if (lo >= T) {
            die(`#${blockId} is beyond the memory: it holds ${plural(T, 'memory')}. Run memory_wake.`);
        }
        const mid = (lo + hi) >> 1;
        const halves: WakeBlock[] = [];
        for (const [a, b] of [[lo, mid], [mid, hi]] as Array<[number, number]>) {
            if (a >= T) continue;
            if (b - a === 1) {
                const e = await this.logGet(a);
                halves.push({ lo: a, hi: a, text: `${e.date} ${e.text}`, isRaw: true });
            } else {
                const s = await this.treeGet(a, b);
                halves.push({ lo: a, hi: b - 1, text: s || 'not compressed yet', isRaw: false });
            }
        }
        return { left: halves[0], right: halves[1] || { lo: mid, hi: mid, text: '', isRaw: true } };
    }

    /**
     * forget: 丢弃树摘要。
     */
    async forget(blockId: string): Promise<{ gone: number; firstId: string }> {
        const [lo, hi] = this.parseBlockId(blockId);
        const gone = await this.treeDrop(lo, hi);
        if (gone.length === 0) {
            die(`No summary at ${blockId}.`);
        }
        return {
            gone: gone.length,
            firstId: `${gone[0][0]}-${gone[0][1] - 1}`,
        };
    }

    /**
     * listEntries: 返回所有原始记忆条目。
     *
     * 流式逐块扫描 LOG（logScan 每块最多 LOG_REC * 4096 字节），
     * 不再一次性分配 T * LOG_REC 字节的 Buffer 全量读入——记忆量大时
     * （如 100 万条 ≈ 320MB）会显著抬高峰值内存。
     *
     * @param limit 可选：最多返回的条目数（不传则返回全部）
     */
    async listEntries(limit?: number): Promise<LogEntry[]> {
        const entries: LogEntry[] = [];
        for await (const e of this.logScan()) {
            entries.push(e);
            if (limit !== undefined && entries.length >= limit) break;
        }
        return entries;
    }

    /** 当前原始记忆总数（O(1)，仅一次 stat；供设置页列表分页/截断展示） */
    async totalEntries(): Promise<number> {
        return this.logLen();
    }

    /**
     * updateEntry: 原地覆写单条原始记忆的文本。
     * 新文本必须不超过固定宽度（LOG_REC - 1 字节，即 319 字节）。
     */
    async updateEntry(id: number, text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) die('Empty. A memory is one line of text.');
        if (trimmed.includes('\n') || trimmed.includes('\r')) {
            die('A memory is one line.');
        }
        const byteLen = Buffer.byteLength(trimmed, 'utf-8');
        if (byteLen > this.config.entryChars) {
            die(`Too long: ${byteLen} bytes, limit ${this.config.entryChars}.`);
        }

        // 校验与读取必须放在锁内：并发 truncateLog/logAppend 改变日志长度后，
        // 基于过期 id 的写入会越过 EOF，产生零填充垃圾记录。
        const release = await this.lock.acquire();
        try {
            const T = await this.logLen();
            if (id < 0 || id >= T) {
                die(`No memory at index ${id}.`);
            }

            // 读取原条目以保留 ID 和日期
            const entry = await this.logGet(id);
            // 整条记录容量校验（头部 + 文本），避免 pad() 处晦涩的 Too long
            assertRecordFits(entry.id, entry.date, trimmed);
            const newLine = `#${entry.id} ${entry.date} ${trimmed}`;

            const buf = pad(newLine, LOG_REC);
            const logPath = this.logPath();
            const handle = await fs.open(logPath, 'r+');
            try {
                await handle.write(buf, 0, buf.length, id * LOG_REC);
            } finally {
                await handle.close();
            }
        } finally {
            release();
        }

        // 编辑后所有覆盖该 ID 的树摘要失效，丢弃之。
        // 必须在锁外执行：dropSummariesCovering → treeDrop 内部会再次 acquire 锁，
        // 而 AsyncLock 不可重入，持锁调用会形成闭环等待死锁（treeDrop 等待的 release
        // 只有 updateEntry 的 finally 才执行）。treeDrop 自身会重新加锁，锁外调用同样安全。
        await this.dropSummariesCovering(id);
    }

    /**
     * deleteEntry: 删除单条原始记忆（真·单条删除，不连坐 truncateLog）。
     *
     * LOG 记录 id = 物理序号（内嵌于记录头 "#id date text"），删除中间某条后其后的
     * 记录 id 整体前移一格，所有树摘要（按 [lo,hi) 块寻址）随之失效，一并清空
     * （下次 recall/compress 按需重建，与 updateEntry/truncateLog 的摘要清理语义一致）。
     * 采用「读全量 → 过滤 → 重编号 → tmp+rename 原子写回」，崩溃安全；
     * 与 truncateLog 的物理截断不同，本方法不会误删目标之后的记忆。
     * 仅删除最后一条时后续 id 不变，但覆盖被删记录的尾部树摘要（如 size=2 的
     * [T-2,T) 块、size=4 的 [0,4) 块）仍引用已删内容：若不清除，T 回升后
     * wake/zoom 会重现已删除的记忆且 pending() 认为该块已压缩而永不重建。
     */
    async deleteEntry(id: number): Promise<{ removed: number }> {
        const release = await this.lock.acquire();
        let T = 0;
        try {
            const logPath = this.logPath();
            await this.repair(logPath, LOG_REC);
            T = await this.logLen();
            if (id < 0 || id >= T) {
                die(`No memory at index ${id}.`);
            }

            if (T === 1) {
                // 唯一一条：直接清空
                const handle = await fs.open(logPath, 'r+');
                try {
                    await handle.truncate(0);
                } finally {
                    await handle.close();
                }
            } else {
                const rebuilt: Buffer[] = [];
                const handle = await fs.open(logPath, 'r');
                try {
                    const rec = Buffer.alloc(LOG_REC);
                    for (let i = 0; i < T; i++) {
                        const { bytesRead } = await handle.read(rec, 0, LOG_REC, i * LOG_REC);
                        if (bytesRead <= 0) break;
                        const str = rec.subarray(0, bytesRead).toString('utf-8').trimEnd();
                        // 遇空记录（损坏文件中的空洞）跳过而不是 break：保留其后仍有效的记录
                        if (!str) continue;
                        if (i === id) continue;
                        const parsed = parse(str);
                        rebuilt.push(pad(`#${rebuilt.length} ${parsed.date} ${parsed.text}`, LOG_REC));
                    }
                } finally {
                    await handle.close();
                }
                // 读句柄已关闭后再写回：Windows 下目标文件被占用时 rename 会 EPERM。
                // tmp+rename 原子替换，崩溃不损坏线上文件。
                const tmpPath = `${logPath}.tmp`;
                await fs.writeFile(tmpPath, Buffer.concat(rebuilt));
                await fs.rename(tmpPath, logPath);
            }

            // 删除后记录编号变化（中间删除整段重编号、尾部删除长度收缩），旧树摘要
            // 的块寻址随之失效——中间删除清空全部；尾部删除按新长度截断（与 truncateLog
            // 同口径），清除覆盖被删记录的尾部块，保留完全位于保留区内的块。
            // 直接用文件操作清空而不调用 treeDrop：treeDrop 内部会重新 acquire 锁（AsyncLock
            // 不可重入，持锁调用会死锁），且其循环以当前 logLen 为界，无法清理 size > 当前
            // 长度的旧树文件。此处仍在锁内：与并发 treePut/logAppend 串行，无交错写风险。
            const newT = T - 1;
            for (let size = 2; size <= T; size *= 2) {
                const p = this.treePath(size);
                const keep = id < newT ? 0 : Math.floor(newT / size);
                const n = await this.count(p, TREE_REC);
                if (n > keep) {
                    await this.repair(p, TREE_REC);
                    const th = await fs.open(p, 'r+');
                    try {
                        await th.truncate(keep * TREE_REC);
                    } finally {
                        await th.close();
                    }
                }
            }
        } finally {
            release();
        }

        return { removed: 1 };
    }

    /** 丢弃所有覆盖给定 ID 的树摘要（编辑记忆后调用） */
    private async dropSummariesCovering(id: number): Promise<void> {
        const T = await this.logLen();
        let size = 2;
        while (size <= T) {
            const lo = Math.floor(id / size) * size;
            const hi = lo + size;
            // 用 treeDrop 丢弃该块及上层
            await this.treeDrop(lo, hi).catch(() => {});
            size *= 2;
        }
    }

    /**
     * truncateLog: 截断原始 LOG，删除 ID >= keepId 的所有记忆及其相关树摘要。
     * keepId=0 表示清空全部记忆。
     */
    async truncateLog(keepId: number): Promise<{ removed: number }> {
        if (keepId < 0) {
            die(`Invalid keepId: ${keepId}.`);
        }

        // T 必须在锁内读取并与截断原子化：若在锁外读取 logLen，期间并发 note
        // 追加的新记录会在 truncate 时被一并截断，removed 数也不准确。
        // logLen 不获取锁（仅 fs.stat），锁内调用不会死锁。
        const release = await this.lock.acquire();
        try {
            const T = await this.logLen();
            if (keepId >= T) {
                return { removed: 0 };
            }
            // 1. 截断 LOG 文件
            const logPath = this.logPath();
            await this.repair(logPath, LOG_REC);
            const logHandle = await fs.open(logPath, 'r+');
            try {
                await logHandle.truncate(keepId * LOG_REC);
            } finally {
                await logHandle.close();
            }

            // 2. 清理所有树摘要：每个 size 截断到 floor(keepId/size) 条
            let size = 2;
            while (size <= T) {
                const p = this.treePath(size);
                const keep = Math.floor(keepId / size);
                const n = await this.count(p, TREE_REC);
                if (n > keep) {
                    await this.repair(p, TREE_REC);
                    const th = await fs.open(p, 'r+');
                    try {
                        await th.truncate(keep * TREE_REC);
                    } finally {
                        await th.close();
                    }
                }
                size *= 2;
            }

            return { removed: T - keepId };
        } finally {
            release();
        }
    }

    /**
     * 获取/设置配置。
     */
    getConfig(): MemoryConfig {
        return { ...this.config };
    }

    async updateConfig(updates: Partial<MemoryConfig>): Promise<MemoryConfig> {
        // 逐项校验：非法值直接抛错（与模块内 die() 的错误风格一致，工具层会转成失败结果），
        // 避免 entryChars 被设为 >319 后所有 note/compress 都在 pad() 抛 Too long。
        const validated: Partial<MemoryConfig> = {};
        for (const [key, min, max] of MEMORY_CONFIG_BOUNDS) {
            const value = updates[key];
            if (value === undefined) continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
                die(`Invalid ${key}: ${String(value)}. Must be an integer between ${min} and ${max}.`);
            }
            validated[key] = value;
        }
        this.config = { ...this.config, ...validated };
        await this.writeConfig(this.config);
        return this.config;
    }

    private async writeConfig(cfg: MemoryConfig): Promise<void> {
        const lines = [
            '# OptMem sizes for this memory.',
            '# Edit with memory_config NAME=VALUE.',
            '',
            `WAKE_LINES   = ${cfg.wakeLines}   # how many lines wake prints`,
            `ENTRY_CHARS  = ${cfg.entryChars}  # max bytes per memory`,
            `PART_CHARS   = ${cfg.partChars}   # max chars per output part`,
            `PART_LINES   = ${cfg.partLines}   # max lines per output part`,
            '',
        ];
        await fs.writeFile(path.join(this.dir, 'config'), lines.join('\n'), 'utf-8');
    }

    /**
     * 从存储目录读取已有配置。
     */
    async loadConfig(): Promise<MemoryConfig> {
        const configPath = path.join(this.dir, 'config');
        try {
            const content = await fs.readFile(configPath, 'utf-8');
            const cfg = { ...DEFAULT_MEMORY_CONFIG };
            for (const line of content.split('\n')) {
                const trimmed = line.split('#')[0].trim();
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx < 0) continue;
                const key = trimmed.substring(0, eqIdx).trim().toUpperCase();
                const val = trimmed.substring(eqIdx + 1).trim();
                if (key === 'WAKE_LINES') cfg.wakeLines = parseInt(val, 10) || cfg.wakeLines;
                if (key === 'ENTRY_CHARS') cfg.entryChars = parseInt(val, 10) || cfg.entryChars;
                if (key === 'PART_CHARS') cfg.partChars = parseInt(val, 10) || cfg.partChars;
                if (key === 'PART_LINES') cfg.partLines = parseInt(val, 10) || cfg.partLines;
            }
            this.config = cfg;
            return cfg;
        } catch {
            return this.config;
        }
    }

    /** 解析块 ID 字符串 "lo-hi" → [lo, hi) */
    parseBlockId(s: string): [number, number] {
        const m = s.match(/^(\d+)-(\d+)$/);
        if (!m) die(`'${s}' is not a block id. Copy it from the prompt.`);
        const lo = parseInt(m[1], 10);
        const hi = parseInt(m[2], 10) + 1;
        const n = hi - lo;
        if (n < 2 || (n & (n - 1)) !== 0 || lo % n !== 0) {
            die(`${s} is not a block. Copy the id printed by wake, like 16-31.`);
        }
        return [lo, hi];
    }

    /** 获取存储目录路径 */
    getStoragePath(): string {
        return this.dir;
    }
}
