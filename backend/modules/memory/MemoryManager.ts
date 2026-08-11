/**
 * GrayCode - MemoryManager
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
import { validateRegexPattern } from '../../core/services/regexGuard';

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

/** 解析一行日志记录；损坏行（无空格头部/非数字 id）返回 null，由调用方跳过 */
function parse(line: string): LogEntry | null {
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
 * 旧版 LOG 固定宽度记录大小（迁移前的 LOG_REC=320）。
 * 旧格式文件（320B/条）在打开时由 repairLog 无损迁移到新格式（LOG_REC=1024B/条）；
 * 迁移判定依赖该常量，勿与 LOG_REC 混淆。
 */
const OLD_LOG_REC = 320;

/** 记录日期字段必须是 ISO 格式（YYYY-MM-DD），用于旧/新格式内容判别 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验「#id date text」整条固定宽度记录可容纳。
 *
 * 固定宽度记录为 LOG_REC 字节，头部 "#<id> <date> " 随 id 位数增长（约 13~23 字节）。
 * 若只按文本长度（entryChars）校验，用户在把 entryChars 调高或 id 位数增长后
 * 会在 pad() 处以晦涩的 "Too long" 报错。此处按实际 id 精确计算可用文本预算。
 */
function assertRecordFits(id: number, date: string, text: string, rec: number = LOG_REC): void {
    const overhead = 1 + String(id).length + 1 + date.length + 1;
    const used = overhead + Buffer.byteLength(text, 'utf-8');
    if (used > rec - 1) {
        die(`Too long: text takes ${used - overhead} bytes, budget ${rec - 1 - overhead} bytes ` +
            `(fixed-width record holds ${rec - 1}, header takes ${overhead}).`);
    }
}

/** 从字节缓冲区解析多条记录；rec 为当前记录宽度（新格式 1024，旧格式降级 320） */
function records(buf: Buffer, rec: number = LOG_REC): LogEntry[] {
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
const MEMORY_CONFIG_BOUNDS: Array<[keyof MemoryConfig, number, number]> = [
    ['wakeLines', 1, 10000],
    ['entryChars', 1, LOG_REC - 1 - MAX_HEADER_BYTES],
];

/** recall 输出字节上限（保持最新匹配；取代已移除的 PART_CHARS 分页配置） */
const RECALL_MAX_BYTES = 20000;

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
    /**
     * 当前 LOG 记录宽度：新格式 1024（默认）；迁移失败且文件为旧格式（320 对齐非 1024 对齐）
     * 时降级为 320——按 1024 解析旧记录会产生空结果/混拼乱码（见 repairLog）。
     */
    private logRecMode: number = LOG_REC;

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

    /** 修复部分写入的尾部记录（crash recovery，用于 TREE 文件） */
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

    /**
     * 修复 LOG 文件（所有 LOG 访问的统一前置入口，必须在锁内调用）：
     * 1. 旧格式（320B/条）无损迁移到新格式（LOG_REC=1024B/条）；
     * 2. 撕裂的尾部半条记录按新宽度截断（与 repair() 语义一致）。
     *
     * 格式判定（按文件大小）：
     * - size % LOG_REC === 0 且非 320 对齐 → 新格式，无需处理；
     * - 其余（旧格式 320 对齐 / 撕裂尾巴 / 同时 320·1024 对齐的歧义尺寸）→ 先尝试严格迁移：
     *   tryMigrateLog 要求「全部完整 320 切片均为合法记录（id 连续、日期 ISO）」才执行重写，
     *   天然区分旧格式与新格式——新格式文件的第二个 320 切片必然落在第一条 1024 记录内部，
     *   解析失败，因此歧义尺寸（lcm=5120 的倍数）无需额外判别；
     * - 迁移未执行时保持现状（fail-open）：对齐文件不动（可能是损坏的旧/新格式，避免截断丢数据），
     *   非对齐文件按 LOG_REC 截断撕裂尾（与旧 repair 行为一致）。
     */
    private async repairLog(): Promise<void> {
        const logPath = this.logPath();
        let size: number;
        try {
            size = (await fs.stat(logPath)).size;
        } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e;
            this.logRecMode = LOG_REC; // 文件不存在，忽略（与 repair 同口径）
            return;
        }
        if (size === 0) {
            this.logRecMode = LOG_REC;
            return;
        }

        // 纯新格式（1024 对齐且非 320 对齐）：无需处理
        if (size % LOG_REC === 0 && size % OLD_LOG_REC !== 0) {
            this.logRecMode = LOG_REC;
            return;
        }

        // 其余：先尝试严格迁移（旧格式 / 旧格式+撕裂尾 / 歧义尺寸中的旧格式）
        if (await this.tryMigrateLog()) {
            this.logRecMode = LOG_REC;
            return;
        }

        // 迁移未执行：保持现状（fail-open，不丢数据）
        if (size % LOG_REC === 0 || size % OLD_LOG_REC === 0) {
            // 对齐文件不动。旧格式（320 对齐非 1024 对齐）→ 读/写降级为 320 宽度：
            // 迁移失败说明含损坏记录，按 1024 解析会产生空结果/混拼乱码，
            // 降级后损坏记录被跳过、合法记录仍可读。
            this.logRecMode = size % LOG_REC === 0 ? LOG_REC : OLD_LOG_REC;
            return;
        }

        // 非对齐（撕裂尾）：必须先判定格式倾向再截断——迁移失败场景下若文件是旧格式
        // （320 对齐的主体 + 撕裂尾），按 1024 截断会直接删掉旧格式字节（M1）。
        // probe 前两条 320 记录判定；probe 无法判定（<640B 小文件）时取截断损失更小的宽度。
        const handle = await fs.open(logPath, 'r');
        let legacyLike: boolean;
        try {
            const legacy = await this.probeLegacyFormat(handle, size);
            legacyLike = legacy !== null ? legacy : size % OLD_LOG_REC <= size % LOG_REC;
        } finally {
            await handle.close();
        }
        if (legacyLike) {
            await this.truncateLogTail(logPath, size, OLD_LOG_REC);
            this.logRecMode = OLD_LOG_REC;
            return;
        }
        await this.truncateLogTail(logPath, size, LOG_REC);
        this.logRecMode = LOG_REC;
    }

    /**
     * 快速判别文件是否为旧格式（320B/条）：前两条 320 记录必须都是合法记录（id 0/1、ISO 日期）。
     *
     * 返回 true = 旧格式嫌疑；false = 确非旧格式（probe 读够且前两条不合法）；
     * null = 文件过小（< 640B，仅一条）无法 probe。
     * 复用于迁移判定（tryMigrateLog）与迁移失败后的截断宽度/降级判定（repairLog）。
     */
    private async probeLegacyFormat(
        handle: import('fs').promises.FileHandle,
        fileSize: number
    ): Promise<boolean | null> {
        if (fileSize < OLD_LOG_REC * 2) return null;
        const probe = Buffer.alloc(OLD_LOG_REC * 2);
        const { bytesRead: probeRead } = await handle.read(probe, 0, probe.length, 0);
        if (probeRead < OLD_LOG_REC * 2) return null;
        const p0 = probe.subarray(0, OLD_LOG_REC).toString('utf-8').trimEnd();
        const p1 = probe.subarray(OLD_LOG_REC, OLD_LOG_REC * 2).toString('utf-8').trimEnd();
        const e0 = p0 ? parse(p0) : null;
        const e1 = p1 ? parse(p1) : null;
        if (!e0 || e0.id !== 0 || !ISO_DATE_RE.test(e0.date) ||
            !e1 || e1.id !== 1 || !ISO_DATE_RE.test(e1.date)) {
            return false; // 非旧格式
        }
        return true;
    }

    /**
     * 把 LOG 从旧格式（OLD_LOG_REC=320B/条）无损迁移到新格式（LOG_REC=1024B/条）：
     * 按 320 逐条解析（复用 parse()），重新 pad 成 1024 写入 tmp，rename 原子替换。
     *
     * 判定/幂等：只有「全部完整 320 切片均为合法记录（id 连续、日期 ISO）」的文件才会被
     * 迁移——新格式或损坏文件任一切片不合法即中止，原文件不动（fail-open，不丢数据）；
     * 迁移成功后文件为 1024 对齐，后续调用直接返回 false。
     * 撕裂尾巴：只迁移完整切片，尾部半条记录被丢弃（与 repair 截断语义一致）。
     * 崩溃安全：写 LOG.txt.tmp 后 rename 原子替换；任何失败/中止都清理 tmp。
     * 必须在锁内调用（写路径经 repairLog，读路径经 ensureLogMigrated）。
     */
    private async tryMigrateLog(): Promise<boolean> {
        const logPath = this.logPath();
        const tmpPath = `${logPath}.tmp`;
        let migrated = false;
        try {
            const handle = await fs.open(logPath, 'r');
            let valid = false;
            try {
                const stat = await handle.stat();
                if (stat.size >= OLD_LOG_REC) {
                    // 快速判别：前两条 320 记录必须都合法（id 0/1、ISO 日期），否则不是旧格式
                    // ——新格式/损坏文件的第二个 320 切片必然落在第一条 1024 记录内部，解析失败。
                    // 避免大文件每次访问都全量扫描（歧义尺寸下 1024 对齐的新文件也会走到这里）。
                    // probe 返回 null（<640B 单条记录小文件）时不拦截，交给全量校验判定。
                    const legacy = await this.probeLegacyFormat(handle, stat.size);
                    if (legacy === false) return false; // 非旧格式
                }
                    const outHandle = await fs.open(tmpPath, 'w');
                    try {
                        valid = true;
                        let outCount = 0;
                        const CHUNK = 4096; // 每次最多处理的旧记录条数（≈1.3MB）
                        for (let base = 0; base < stat.size; base += CHUNK * OLD_LOG_REC) {
                            const bytes = Math.min(CHUNK * OLD_LOG_REC, stat.size - base);
                            const buf = Buffer.alloc(bytes);
                            const { bytesRead } = await handle.read(buf, 0, bytes, base);
                            const effective = Math.floor(bytesRead / OLD_LOG_REC);
                            const kept: Buffer[] = [];
                            for (let i = 0; i < effective; i++) {
                                const idx = base / OLD_LOG_REC + i; // 旧格式 id 连续，切片序号即期望 id
                                const slice = buf.subarray(i * OLD_LOG_REC, (i + 1) * OLD_LOG_REC);
                                const str = slice.toString('utf-8').trimEnd();
                                const entry = str ? parse(str) : null;
                                // 严格校验：任一完整切片不是合法记录（空/损坏/id 不连续/日期非 ISO）
                                // 即中止迁移——防止把新格式或损坏文件误判为旧格式而重写损坏。
                                if (!entry || entry.id !== idx || !ISO_DATE_RE.test(entry.date)) {
                                    valid = false;
                                    break;
                                }
                                kept.push(pad(`#${outCount} ${entry.date} ${entry.text}`, LOG_REC));
                                outCount++;
                            }
                            if (!valid) break;
                            if (kept.length > 0) await outHandle.write(Buffer.concat(kept));
                        }
                    } finally {
                        await outHandle.close();
                    }
            } finally {
                await handle.close();
            }
            if (valid) {
                // 读写句柄都已关闭后再 rename（Windows 下目标被占用会 EPERM，与 deleteRange 同理）
                await fs.rename(tmpPath, logPath);
                migrated = true;
            } else {
                await fs.unlink(tmpPath).catch(() => { /* 无残留则忽略 */ });
            }
        } catch (e: any) {
            // fail-open：迁移失败不影响正常读写——原文件不动，仅告警（残留 tmp 由下次尝试清理）
            try { await fs.unlink(tmpPath); } catch { /* 忽略 */ }
            console.warn(`[MemoryManager] LOG migration skipped (${e?.message ?? e}); the file is kept as-is.`);
        }
        return migrated;
    }

    /** 截断撕裂的尾部半条记录（与 repair(filePath, rec) 的截断语义一致，宽度为 rec） */
    private async truncateLogTail(logPath: string, size: number, rec: number = LOG_REC): Promise<void> {
        const handle = await fs.open(logPath, 'r+');
        try {
            await handle.truncate(size - (size % rec));
        } finally {
            await handle.close();
        }
    }

    /**
     * 确保 LOG 已迁移到新格式（读取路径的最早入口）。
     * 只允许在未持锁的调用链中调用（wake/recall/compress/zoom/listEntries/totalEntries 等
     * 公开读取入口）；持锁路径（写操作）直接调用 repairLog——本方法内部会取锁，不可重入。
     */
    private async ensureLogMigrated(): Promise<void> {
        const release = await this.lock.acquire();
        try {
            await this.repairLog();
        } finally {
            release();
        }
    }

    /** 获取记录数量 */
    private async count(filePath: string, rec: number): Promise<number> {
        try {
            const stat = await fs.stat(filePath);
            return Math.floor(stat.size / rec);
        } catch (e: any) {
            // 只有「文件不存在」视为空；权限/IO 错误应上抛而不是静默当成 0 条，
            // 否则 wake 会在文件实际不可读时谎报「没有记忆」。
            if (e?.code !== 'ENOENT') throw e;
            return 0;
        }
    }

    private async logLen(): Promise<number> {
        return this.count(this.logPath(), this.logRecMode);
    }

    /** 追加日志记录，返回起始 ID */
    private async logAppend(items: Array<{ date: string; text: string }>): Promise<number> {
        const release = await this.lock.acquire();
        try {
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const rec = this.logRecMode;
            const base = await this.logLen();
            const chunks: Buffer[] = [];
            for (let k = 0; k < items.length; k++) {
                const { date, text } = items[k];
                // 锁内用真实分配的 id 精确校验整条记录容量（含 "#<id> <date> " 头部开销）：
                // id 由本方法在锁内分配，此处校验与实际写入完全一致，不存在估算竞态
                // （锁外按 logLen 估算可能低估 id 位数，并发追加时仍会在 pad() 抛晦涩 Too long）。
                assertRecordFits(base + k, date, text, rec);
                chunks.push(pad(`#${base + k} ${date} ${text}`, rec));
            }
            await fs.appendFile(this.logPath(), Buffer.concat(chunks));
            return base;
        } finally {
            release();
        }
    }

    /** 读取指定范围的日志记录 */
    private async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
        const rec = this.logRecMode;
        const handle = await fs.open(this.logPath(), 'r');
        try {
            const buf = Buffer.alloc((hi - lo) * rec);
            const { bytesRead } = await handle.read(buf, 0, buf.length, lo * rec);
            if (bytesRead < buf.length) {
                // 记录不足，截取实际读取的部分
                return records(buf.subarray(0, bytesRead), rec);
            }
            return records(buf, rec);
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
        const rec = this.logRecMode;
        let handle: import('fs').promises.FileHandle | null = null;
        try {
            handle = await fs.open(this.logPath(), 'r');
            let offset = 0;
            while (true) {
                const buf = Buffer.alloc(rec * 4096);
                const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
                if (bytesRead === 0) break;
                const entries = records(buf.subarray(0, bytesRead), rec);
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
            const targetIndex = lo / size;
            if (n < targetIndex) {
                // 缺槽原因：目标槽之前的块缺失（树被并发截断/越序压缩）。
                // 不能静默 return false——compress() 会误报「已被其他会话压缩」；
                // 给出可操作提示：按序执行 memory_compress 重建缺失块。
                die(`Cannot write #${lo}-${hi - 1}: ${n} of ${targetIndex} tree blocks present, ` +
                    `earlier blocks are missing. Run memory_compress to build pending blocks in order.`);
            }
            if (n === targetIndex) {
                await fs.appendFile(p, pad(text, TREE_REC));
                return true;
            }

            // treeDrop 会把中间槽位清空以保留后续块；允许重新压缩时复用该空槽。
            const handle = await fs.open(p, 'r+');
            try {
                const buffer = Buffer.alloc(TREE_REC);
                await handle.read(buffer, 0, TREE_REC, targetIndex * TREE_REC);
                if (buffer.toString('utf8').replace(/\0+$/g, '').trim()) return false;
                const record = pad(text, TREE_REC);
                await handle.write(record, 0, record.length, targetIndex * TREE_REC);
                return true;
            } finally {
                await handle.close();
            }
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
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const T = await this.logLen();
            while (size <= T) {
                const p = this.treePath(size);
                // 只删除覆盖被删区间 [lo, hi) 的块（索引 kStart..kEnd），
                // 不再连带删除 kStart 之后的所有块：此前 truncate(k*TREE_REC)
                // 会误删不含被删记忆的后缀块，forget 的 gone/firstId 与实际失效范围
                // 不符，且这些块被清空后 pending 会反复要求重新压缩。
                const kStart = Math.floor(lo / size);
                const kEnd = Math.floor((hi - 1) / size);
                const n = await this.count(p, TREE_REC);
                const clearEnd = Math.min(n, kEnd + 1);
                if (clearEnd > kStart) {
                    const handle = await fs.open(p, 'r+');
                    try {
                        const emptyRecord = pad('', TREE_REC);
                        for (let i = kStart; i < clearEnd; i++) {
                            const buffer = Buffer.alloc(TREE_REC);
                            await handle.read(buffer, 0, TREE_REC, i * TREE_REC);
                            if (buffer.toString('utf8').replace(/\0+$/g, '').trim()) {
                                gone.push([i * size, (i + 1) * size]);
                                await handle.write(emptyRecord, 0, emptyRecord.length, i * TREE_REC);
                            }
                        }

                        // 尾部空槽可安全截断；中间空槽必须保留索引，供后续 treePut 复用。
                        let trailingCount = n;
                        const buffer = Buffer.alloc(TREE_REC);
                        while (trailingCount > 0) {
                            buffer.fill(0);
                            await handle.read(buffer, 0, TREE_REC, (trailingCount - 1) * TREE_REC);
                            if (buffer.toString('utf8').replace(/\0+$/g, '').trim()) break;
                            trailingCount--;
                        }
                        if (trailingCount < n) {
                            await handle.truncate(trailingCount * TREE_REC);
                        }
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
        // 用尽剩余预算：拆分最大的块。用最大堆按块大小选取，替代逐次线性扫描的 O(budget²)
        //（wakeLines 上限 10000 时旧实现最坏约 5×10⁷ 次迭代，B-5）。
        const result = [...out];
        if (result.length < budget) {
            const heap: Array<[number, number]> = result.slice();
            const sizeOf = (b: [number, number]): number => b[1] - b[0];
            const siftDown = (i: number, n: number): void => {
                while (true) {
                    let largest = i;
                    const l = 2 * i + 1;
                    const r = 2 * i + 2;
                    if (l < n && sizeOf(heap[l]) > sizeOf(heap[largest])) largest = l;
                    if (r < n && sizeOf(heap[r]) > sizeOf(heap[largest])) largest = r;
                    if (largest === i) return;
                    [heap[i], heap[largest]] = [heap[largest], heap[i]];
                    i = largest;
                }
            };
            const siftUp = (i: number): void => {
                while (i > 0) {
                    const parent = (i - 1) >> 1;
                    if (sizeOf(heap[parent]) >= sizeOf(heap[i])) return;
                    [heap[parent], heap[i]] = [heap[i], heap[parent]];
                    i = parent;
                }
            };
            for (let i = (heap.length >> 1) - 1; i >= 0; i -= 1) siftDown(i, heap.length);
            while (heap.length < budget) {
                if (sizeOf(heap[0]) <= 1) break;
                const [l, h] = heap[0];
                const m = (l + h) >> 1;
                heap[0] = [l, m];
                siftDown(0, heap.length);
                heap.push([m, h]);
                siftUp(heap.length - 1);
            }
            result.splice(0, result.length, ...heap);
        }
        // 堆按块大小组织，需按 lo 还原输出顺序（wake 依赖块按 lo 升序做连续原始块合并）
        result.sort((a, b) => a[0] - b[0]);
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
            // count 只反映「文件里有多少个槽位」，不能反映「哪些槽位有内容」：
            // treeDrop 会把中间槽位写成空记录（保留索引供 treePut 复用），
            // 空槽从未被压缩，必须重新进入待压缩队列。
            // k >= have 的槽位从未写入，直接视为待压缩（保持原有 count 语义）；
            // k < have 的槽位逐槽读内容判空，空槽同样视为待压缩。
            for (let k = 0; k < maxK; k++) {
                if (k < have) {
                    const s = await this.treeGet(k * size, (k + 1) * size);
                    if (s !== null) continue; // 已有摘要
                }
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
            const have = await this.count(this.treePath(size), TREE_REC);
            const maxK = Math.floor(T / size);
            // 与 pending() 同口径：[have, maxK) 从未写入全部待压缩；
            // [0, have) 内 treeDrop 留下的空记录也算待压缩
            let pendingBlocks = Math.max(0, maxK - have);
            for (let k = 0; k < have && k < maxK; k++) {
                const s = await this.treeGet(k * size, (k + 1) * size);
                if (s === null) pendingBlocks++;
            }
            n += pendingBlocks;
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
        // 修改原因：compress 的摘要预算已按树记录宽度钳制（min(entryChars, TREE_REC-1)，见 compress），
        //          提示语必须使用同一预算并按字节计，否则模型按 entryChars 生成超长摘要必然被拒。
        const summaryLimit = Math.min(this.config.entryChars, TREE_REC - 1);
        const prompt = `Compress memories #${lo}-${hi - 1} into one line of at most ${summaryLimit} bytes.\n` +
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

    // ─── 公共 API ─────────────────────────────

    /**
     * wake: 唤醒全部可用记忆（单次输出，不再分页）。
     * 输出受 WAKE_LINES 行预算约束：近期记忆保持原文，远期记忆以摘要形式覆盖。
     */
    async wake(part?: number, T?: number): Promise<WakeResult> {
        await this.ensureLogMigrated();
        const now = await this.logLen();
        if (now === 0) {
            return {
                blocks: [],
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
        for (const [lo, hi] of this.cover(now, this.config.wakeLines)) {
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
                const pc = await this.pendingCount(now);
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

        const blocks = this.parseWakeBlocks(lines);

        let pendingCompression: NapPrompt | undefined;
        const nap = await this.nextNap(now);
        if (nap) pendingCompression = nap;

        return {
            blocks,
            totalMemories: now,
            awake: true,
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
        await this.ensureLogMigrated();
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
            while (size > RECALL_MAX_BYTES && head < matches.length) {
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
        await this.ensureLogMigrated();
        const T = await this.logLen();
        let said = false;

        if (blockId && summary === undefined) {
            die('summary is required when blockId is provided.');
        }

        if (blockId && summary !== undefined) {
            const [lo, hi] = this.parseBlockId(blockId);
            const todo = await this.pending(T, 1);
            if (todo.length === 0) {
                // B-7: 无待压缩块时也要校验请求块——越界/未压缩的块给出明确错误，
                // 而不是静默返回 done:0（已压缩的块重复提交仍幂等返回 done:0）。
                const existing = await this.treeGet(lo, hi);
                if (existing === null) {
                    die(`Wrong block: ${blockId}. Nothing is pending for compression. Run memory_compress.`);
                }
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
                // 修改原因：树摘要写入 treePut 用 TREE_REC=288 的固定宽度记录，pad() 只容纳
                //           TREE_REC-1=287 字节；entryChars 上限按 LOG 记录宽度（约 1000）校验，
                //           配置调高后 288+ 字节的摘要能通过 entryChars 校验，却在 treePut 的
                //           pad() 处抛晦涩的 "Too long"（拒绝而非损坏，但体验差）。
                // 修改方式：compress 的摘要预算按树记录宽度钳制为 min(entryChars, TREE_REC-1)，
                //           校验失败的错误信息与真实落盘容量一致，且与 napPrompt 提示同口径。
                // 修改目的：配置调高后 compress 不再因记录宽度限制报错。
                const summaryLimit = Math.min(this.config.entryChars, TREE_REC - 1);
                if (byteLen > summaryLimit) {
                    die(`Too long: ${byteLen} bytes, limit ${summaryLimit}.`);
                }
                const ok = await this.treePut(lo, hi, trimmed);
                if (ok) {
                    // 只有真正写入成功才置 said=true：
                    // 块已存在或 treePut 返回 false（并行会话已处理）时保持 said=false，
                    // 避免上报 done:1 与实际写入不符。
                    said = true;
                } else {
                    // B-7: treePut 返回 false（并行会话已压缩该块）时明确告警，不再静默丢弃摘要；
                    // 保持 said=false（done:0），与并行会话幂等语义一致。
                    console.warn(`[MemoryManager] Block ${blockId} was already compressed by another session; summary not written.`);
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
        await this.ensureLogMigrated();
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
     * （如 100 万条 ≈ 1GB）会显著抬高峰值内存。
     *
     * @param limit 可选：最多返回的条目数（不传则返回全部）
     */
    async listEntries(limit?: number): Promise<LogEntry[]> {
        await this.ensureLogMigrated();
        const entries: LogEntry[] = [];
        for await (const e of this.logScan()) {
            entries.push(e);
            if (limit !== undefined && entries.length >= limit) break;
        }
        return entries;
    }

    /** 当前原始记忆总数（O(1)，仅一次 stat；供设置页列表分页/截断展示） */
    async totalEntries(): Promise<number> {
        await this.ensureLogMigrated();
        return this.logLen();
    }

    /**
     * updateEntry: 原地覆写单条原始记忆的文本。
     * 新文本必须不超过固定宽度（LOG_REC - 1 字节，即 1023 字节）。
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
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const rec = this.logRecMode;
            const T = await this.logLen();
            if (id < 0 || id >= T) {
                die(`No memory at index ${id}.`);
            }

            // 读取原条目以保留 ID 和日期
            const entry = await this.logGet(id);
            // 整条记录容量校验（头部 + 文本），避免 pad() 处晦涩的 Too long
            assertRecordFits(entry.id, entry.date, trimmed, rec);
            const newLine = `#${entry.id} ${entry.date} ${trimmed}`;

            const buf = pad(newLine, rec);
            const logPath = this.logPath();
            const handle = await fs.open(logPath, 'r+');
            try {
                await handle.write(buf, 0, buf.length, id * rec);
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
     * deleteRange: 删除闭区间 [lo, hi] 内的所有原始记忆（真·单条/批量删除，不连坐 truncateLog）。
     *
     * LOG 记录 id = 物理序号（内嵌于记录头 "#id date text"），删除中间某条后其后的
     * 记录 id 整体前移一格，所有树摘要（按 [lo,hi) 块寻址）随之失效，一并清空
     * （下次 recall/compress 按需重建，与 updateEntry/truncateLog 的摘要清理语义一致）。
     * 采用「读全量 → 过滤 → 重编号 → tmp+rename 原子写回」，崩溃安全；
     * 与 truncateLog 的物理截断不同，本方法不会误删目标之后的记忆。
     * 仅删除尾部的区间时后续 id 不变，但覆盖被删记录的尾部树摘要（如 size=2 的
     * [T-2,T) 块、size=4 的 [0,4) 块）仍引用已删内容：若不清除，T 回升后
     * wake/zoom 会重现已删除的记忆且 pending() 认为该块已压缩而永不重建。
     */
    async deleteRange(lo: number, hi: number): Promise<{ removed: number }> {
        const release = await this.lock.acquire();
        let T = 0;
        try {
            // 输入校验：非整数/NaN 不得进入，避免 NaN 比较恒 false 导致静默全量重写；
            // 负数属于“越界”，交给下方 lo < 0 检查抛 “No memory at index”，语义更准确
            if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
                die(`Invalid delete range: lo=${lo}, hi=${hi}.`);
            }
            const logPath = this.logPath();
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            T = await this.logLen();
            if (lo < 0 || lo >= T) {
                die(`No memory at index ${lo}.`);
            }
            if (hi < lo || hi >= T) {
                die(`No memory at index ${hi}.`);
            }

            const tmpPath = `${logPath}.tmp`;
            const handle = await fs.open(logPath, 'r');
            const outHandle = await fs.open(tmpPath, 'w');
            let outCount = 0;
            try {
                // B-6: 分块读取（每次至多 CHUNK 条），避免百万条记忆时逐条 1KB read 的百万次系统调用。
                // 物理索引对齐与空/损坏记录跳过语义与旧实现一致。
                // 流式写 tmp：不再全量累积 rebuilt 数组，峰值内存从 O(T·LOG_REC) 降为 O(CHUNK·LOG_REC)。
                const CHUNK = 4096;
                const rec = this.logRecMode;
                for (let base = 0; base < T; base += CHUNK) {
                    const count = Math.min(CHUNK, T - base);
                    const buf = Buffer.alloc(count * rec);
                    const { bytesRead } = await handle.read(buf, 0, buf.length, base * rec);
                    const effective = Math.floor(bytesRead / rec);
                    const kept: Buffer[] = [];
                    for (let i = 0; i < effective; i++) {
                        const idx = base + i;
                        const slice = buf.subarray(i * rec, (i + 1) * rec);
                        const str = slice.toString('utf-8').trimEnd();
                        // 遇空记录（损坏文件中的空洞）跳过而不是 break：保留其后仍有效的记录
                        if (!str) continue;
                        if (idx >= lo && idx <= hi) continue;
                        const parsed = parse(str);
                        if (!parsed) {
                            continue; // B-9: 损坏行跳过（不重建），与 records() 解析口径一致
                        }
                        kept.push(pad(`#${outCount} ${parsed.date} ${parsed.text}`, rec));
                        outCount++;
                    }
                    if (kept.length > 0) {
                        await outHandle.write(Buffer.concat(kept));
                    }
                }
            } finally {
                await outHandle.close();
                await handle.close();
            }

            // 先清树摘要、后原子换 LOG：树是缓存，缺失只触发重建（安全）；
            // 陈旧摘要会被 wake/zoom 当作权威数据展示（危险）。若先 rename LOG 再截断树，
            // 崩溃窗口内新 LOG + 旧摘要共存，已删记忆会在 wake 中“复活”且 pending() 认为
            // 已压缩永不重建。顺序反之后，崩溃窗口最多是“摘要缺失”，自愈安全。
            const newT = T - (hi - lo + 1);
            for (let size = 2; size <= T; size *= 2) {
                const p = this.treePath(size);
                const keep = hi < T - 1 ? 0 : Math.floor(newT / size);
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

            // 读/写句柄已关闭后再 rename：Windows 下目标文件被占用时 rename 会 EPERM。
            // tmp+rename 原子替换，崩溃不损坏线上文件。
            await fs.rename(tmpPath, logPath);
        } finally {
            release();
        }

        return { removed: hi - lo + 1 };
    }

    /**
     * deleteEntry: 删除单条原始记忆（真·单条删除，不连坐 truncateLog）。
     */
    async deleteEntry(id: number): Promise<{ removed: number }> {
        return this.deleteRange(id, id);
    }

    /**
     * deleteEntries: 批量删除多条原始记忆。
     *
     * 接收非负整数 id 数组（可乱序、可重复），内部排序去重后单次流式扫描 LOG：
     * 按原始索引跳过目标 id、重编号写 tmp 后原子换回（等价于“从大到小逐个删除”，
     * 但只扫描一次 LOG），返回实际删除条数。删除后相关树摘要一并清空。
     */
    async deleteEntries(ids: number[]): Promise<{ removed: number }> {
        if (!Array.isArray(ids)) {
            die('deleteEntries: ids must be an array.');
        }
        const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
        if (sorted.length === 0) {
            return { removed: 0 };
        }
        // 防御：非负整数校验（调用方已校验，这里是 API 层兜底，防止 NaN/负数/浮点进入删除逻辑）
        if (sorted.some(id => !Number.isInteger(id) || id < 0)) {
            die('deleteEntries: ids must be non-negative integers.');
        }

        const release = await this.lock.acquire();
        try {
            const logPath = this.logPath();
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const T = await this.logLen();
            const maxId = sorted[sorted.length - 1];
            if (maxId >= T) {
                die(`No memory at index ${maxId}.`);
            }

            // 合并相邻 id 为闭区间（仅用于尾部判定，删除本身按 id 集合单次扫描）
            const ranges: Array<[number, number]> = [];
            for (const id of sorted) {
                const last = ranges[ranges.length - 1];
                if (last && id === last[1] + 1) {
                    last[1] = id;
                } else {
                    ranges.push([id, id]);
                }
            }
            const toDelete = new Set(sorted);

            // 单次流式扫描 LOG：跳过分组内的 id、重编号后写 tmp，
            // 替代原先对每个区间重复全量扫描（多个区间 = 多次 O(T) 扫描）。
            const tmpPath = `${logPath}.tmp`;
            const handle = await fs.open(logPath, 'r');
            const outHandle = await fs.open(tmpPath, 'w');
            let outCount = 0;
            try {
                const CHUNK = 4096;
                // 对齐必须按当前记录宽度（旧格式降级 320B/条）进行：按 LOG_REC=1024 对齐
                // 会读错偏移，重编号后 tmp 近乎全空，rename 会用空文件覆盖 LOG.txt → 全量记忆丢失
                const rec = this.logRecMode;
                for (let base = 0; base < T; base += CHUNK) {
                    const count = Math.min(CHUNK, T - base);
                    const buf = Buffer.alloc(count * rec);
                    const { bytesRead } = await handle.read(buf, 0, buf.length, base * rec);
                    const effective = Math.floor(bytesRead / rec);
                    const kept: Buffer[] = [];
                    for (let i = 0; i < effective; i++) {
                        const idx = base + i;
                        const slice = buf.subarray(i * rec, (i + 1) * rec);
                        const str = slice.toString('utf-8').trimEnd();
                        // 空/损坏记录跳过语义与 deleteRange 一致
                        if (!str) continue;
                        if (toDelete.has(idx)) continue;
                        const parsed = parse(str);
                        if (!parsed) continue;
                        kept.push(pad(`#${outCount} ${parsed.date} ${parsed.text}`, rec));
                        outCount++;
                    }
                    if (kept.length > 0) {
                        await outHandle.write(Buffer.concat(kept));
                    }
                }
            } finally {
                await outHandle.close();
                await handle.close();
            }

            // 树摘要清理（与 deleteRange 多区间聚合后的最终语义一致）：
            // 仅当删除恰好构成一个覆盖日志尾部的单区间时保留其前缀块，
            // 否则全部清空——多区间/非尾部删除时任何块都可能因重编号而失效。
            const newT = T - sorted.length;
            const tailSingleRange = ranges.length === 1 && ranges[0][1] === T - 1;
            for (let size = 2; size <= T; size *= 2) {
                const p = this.treePath(size);
                const keep = tailSingleRange ? Math.floor(newT / size) : 0;
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

            // 树清理完成后原子换 LOG（顺序与 deleteRange 一致：先清树、后换 LOG）
            await fs.rename(tmpPath, logPath);
            return { removed: sorted.length };
        } finally {
            release();
        }
    }

    /** 丢弃所有覆盖给定 ID 的树摘要（编辑记忆后调用） */
    private async dropSummariesCovering(id: number): Promise<void> {
        const T = await this.logLen();
        let size = 2;
        while (size <= T) {
            const lo = Math.floor(id / size) * size;
            const hi = lo + size;
            // 用 treeDrop 丢弃该块及上层
            try {
                await this.treeDrop(lo, hi);
            } catch (err) {
                // B-3: 丢弃失败至少告警，不再静默吞掉（树是缓存，缺失可重建，但需可观测）
                console.warn(`[MemoryManager] Failed to drop summaries covering #${lo}-${hi - 1}:`, err);
            }
            size *= 2;
        }
    }

    /**
     * truncateLog: 截断原始 LOG，删除 ID >= keepId 的所有记忆及其相关树摘要。
     * keepId=0 表示清空全部记忆。
     */
    async truncateLog(keepId: number): Promise<{ removed: number }> {
        // B-4: Number.isInteger 校验——NaN 绕过 keepId<0 检查后 fs.truncate(NaN) 会抛晦涩错误
        if (!Number.isInteger(keepId) || keepId < 0) {
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
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const logHandle = await fs.open(logPath, 'r+');
            try {
                await logHandle.truncate(keepId * this.logRecMode);
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
        // 避免 entryChars 被设为 >1000 后所有 note/compress 都在 pad() 抛 Too long。
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
        // B-2: 返回拷贝，调用方修改返回对象不能绕过校验污染内部 config
        return { ...this.config };
    }

    private async writeConfig(cfg: MemoryConfig): Promise<void> {
        const lines = [
            '# OptMem sizes for this memory.',
            '# Edit with memory_config NAME=VALUE.',
            '',
            `WAKE_LINES   = ${cfg.wakeLines}   # how many lines wake prints`,
            `ENTRY_CHARS  = ${cfg.entryChars}  # max bytes per memory`,
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
            }
            // 复用 MEMORY_CONFIG_BOUNDS 钳制非法值：配置文件可能被手工改出界
            // （如 ENTRY_CHARS 超上限），未钳制会在 note/compress 的 pad() 处抛
            // 晦涩 Too long——与 updateConfig 的校验口径保持一致（此处只钳制不抛错）。
            for (const [key, min, max] of MEMORY_CONFIG_BOUNDS) {
                const value = cfg[key];
                if (value < min) cfg[key] = min;
                else if (value > max) cfg[key] = max;
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

