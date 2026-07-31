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

/** 从字节缓冲区解析多条记录 */
function records(buf: Buffer): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < buf.length; i += LOG_REC) {
        const slice = buf.subarray(i, i + LOG_REC);
        const str = slice.toString('utf-8').trimEnd();
        if (str) {
            out.push(parse(str));
        }
    }
    return out;
}

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
        } catch {
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
        try {
            const handle = await fs.open(this.logPath(), 'r');
            try {
                let offset = 0;
                while (true) {
                    const buf = Buffer.alloc(LOG_REC * 4096);
                    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
                    if (bytesRead === 0) break;
                    const entries = records(buf.subarray(0, bytesRead));
                    for (const e of entries) yield e;
                    offset += bytesRead;
                }
            } finally {
                await handle.close();
            }
        } catch {
            // 文件不存在，什么都不产出
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
        for (let i = 0; i < 60; i++) {
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
        for (const [lo, hi] of this.cover(snapshotT, this.config.wakeLines)) {
            if (hi - lo === 1) {
                const e = await this.logGet(lo);
                lines.push(`#${e.id} ${e.date} ${e.text}`);
            } else {
                let s = await this.treeGet(lo, hi);
                if (s === null) {
                    const nap = await this.nextNap(snapshotT);
                    if (nap) {
                        const pc = await this.pendingCount(snapshotT);
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
        const id = await this.logAppend([{ date: today, text: trimmed }]);

        const nap = await this.nextNap(id + 1);
        return { id, pendingCompression: nap ?? undefined };
    }

    /**
     * recall: 正则搜索全部记忆。
     */
    async recall(regex: string): Promise<RecallResult> {
        let pat: RegExp;
        try {
            pat = new RegExp(regex, 'i');
        } catch (e: any) {
            die(`bad regex: ${e.message}`);
        }

        const matches: string[] = [];
        let totalHits = 0;
        let size = 0;

        for await (const e of this.logScan()) {
            const line = `#${e.id} ${e.date} ${e.text}`;
            if (!pat.test(line)) continue;
            totalHits++;
            matches.push(line);
            size += Buffer.byteLength(line, 'utf-8') + 1;
            // 保持最新的匹配，丢弃最旧的
            while (size > this.config.partChars && matches.length > 0) {
                size -= Buffer.byteLength(matches.shift()!, 'utf-8') + 1;
            }
        }

        if (totalHits === 0) {
            return { lines: [], totalHits: 0, truncated: false };
        }

        const truncated = matches.length < totalHits;
        return { lines: matches, totalHits, truncated };
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
            said = true;
            const [lo, hi] = this.parseBlockId(blockId);
            const todo = await this.pending(T, 1);
            if (todo.length === 0) {
                return { done: 0 };
            }
            if (lo !== todo[0][0] || hi !== todo[0][1]) {
                const existing = await this.treeGet(lo, hi);
                if (existing !== null) {
                    // 已经存在，不报错
                } else {
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
                    // 成功写入
                } else {
                    // 已被并行操作处理
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
     */
    async listEntries(): Promise<LogEntry[]> {
        const T = await this.logLen();
        if (T === 0) return [];
        return this.logSlice(0, T);
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
        const T = await this.logLen();
        if (keepId >= T) {
            return { removed: 0 };
        }
        if (keepId < 0) {
            die(`Invalid keepId: ${keepId}.`);
        }

        const release = await this.lock.acquire();
        try {
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
        this.config = { ...this.config, ...updates };
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
