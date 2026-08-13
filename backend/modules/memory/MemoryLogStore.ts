/**
 * GrayCode - Memory LOG/TREE 底层存储
 *
 * 负责 LOG（追加式日志）与 TREE（二叉树摘要缓存）的读写、旧格式迁移、
 * 槽位位图缓存，以及删除/截断等文件级操作。所有操作由内部 AsyncLock 串行化。
 * 从 MemoryManager.ts 抽离（纯重构，行为不变）。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    LOG_REC, TREE_REC,
    type LogEntry, type MemoryConfig,
} from './types';
import { AsyncLock } from './AsyncLock';
import {
    assertRecordFits, die, ISO_DATE_RE, OLD_LOG_REC, pad, parse, records,
} from './logFormat';

export class MemoryLogStore {
    private dir: string;
    private lock = new AsyncLock();
    /**
     * 当前 LOG 记录宽度：新格式 1024（默认）；迁移失败且文件为旧格式（320 对齐非 1024 对齐）
     * 时降级为 320——按 1024 解析旧记录会产生空结果/混拼乱码（见 repairLog）。
     */
    private logRecMode: number = LOG_REC;

    /**
     * TREE 槽位占用位图缓存（size -> { mtimeMs, fileSize, slots }）：
     * pending/pendingCount 逐槽 open/read 判断空槽在记忆量大时是 O(T) 次文件句柄循环，
     * 缓存整文件位图后一次 stat 命中即可复用；slots[k] = true 表示槽位 k 有非空记录。
     * 写路径（treePut/treeDrop/deleteRange/deleteEntries/truncateLog）在锁内主动失效，
     * 读路径以 mtime+size 一致性兜底并发窗口，双保险避免陈旧位图。
     */
    private treeSlotCache = new Map<number, { mtimeMs: number; fileSize: number; slots: boolean[] }>();

    /**
     * 配置访问器：updateEntry 需要 entryChars 做写入前校验。
     * 由 MemoryManager 注入，保持单一配置真源。
     */
    private getConfig: () => MemoryConfig;

    constructor(dir: string, getConfig: () => MemoryConfig) {
        this.dir = dir;
        this.getConfig = getConfig;
    }

    /** 初始化存储目录结构（创建 TREE 目录与空 LOG.txt） */
    async initStorage(): Promise<void> {
        await fs.mkdir(path.join(this.dir, 'TREE'), { recursive: true });
        const logPath = this.logPath();
        try {
            await fs.access(logPath);
        } catch {
            await fs.writeFile(logPath, '');
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
    async ensureLogMigrated(): Promise<void> {
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
            // 只有「文件不存在」视为空；其余 IO 错误应上抛而不是静默当作 0 条，
            // 否则 wake 会在文件实际不可读时谎报「没有记忆」。
            if (e?.code !== 'ENOENT') throw e;
            return 0;
        }
    }

    async logLen(): Promise<number> {
        return this.count(this.logPath(), this.logRecMode);
    }

    /** 追加日志记录，返回起始 ID */
    async logAppend(items: Array<{ date: string; text: string }>): Promise<number> {
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
    async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
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
    async logGet(i: number): Promise<LogEntry> {
        const entries = await this.logSlice(i, i + 1);
        if (entries.length === 0) die(`No memory at index ${i}`);
        return entries[0];
    }

    /**
     * 读取位置 i 的原始固定宽度记录并返回其 id；记录缺失（日志被截断）或无法解析
     * （损坏行）返回 null。仅用于 wake 末条「缺失 vs 损坏」的错误路径判别，
     * 不参与正常读取（正常读取走 records() 跳过损坏行）。
     */
    async rawEntryIdAt(i: number): Promise<number | null> {
        const rec = this.logRecMode;
        let handle: import('fs').promises.FileHandle;
        try {
            handle = await fs.open(this.logPath(), 'r');
        } catch (e: any) {
            if (e?.code === 'ENOENT') return null;
            throw e;
        }
        try {
            const buf = Buffer.alloc(rec);
            const { bytesRead } = await handle.read(buf, 0, rec, i * rec);
            if (bytesRead < rec) return null; // 记录缺失（日志被截断）
            const entry = parse(buf.toString('utf-8').trimEnd());
            return entry ? entry.id : null;
        } finally {
            await handle.close();
        }
    }

    /** 流式扫描全部日志 */
    async *logScan(): AsyncGenerator<LogEntry> {
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
    async treeGet(lo: number, hi: number): Promise<string | null> {
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
    async treePut(lo: number, hi: number, text: string): Promise<boolean> {
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
                this.treeCacheInvalidate(size);
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
                this.treeCacheInvalidate(size);
                return true;
            } finally {
                await handle.close();
            }
        } finally {
            release();
        }
    }

    /** 使某 size 树文件的槽位位图缓存失效（树写路径在锁内调用） */
    private treeCacheInvalidate(size: number): void {
        this.treeSlotCache.delete(size);
    }

    /**
     * 读取树文件槽位占用位图（pending/pendingCount 共享）：
     * mtime+size 与缓存一致时直接复用，否则整文件一次读入构建位图并缓存——
     * 替代逐槽 open/read/close（记忆量大时 O(T) 次文件句柄循环）。
     * 文件不存在视为 0 槽；写路径已主动失效（treeCacheInvalidate），读路径以
     * mtime+size 一致性 + cache.set 前二次 stat 双重兜底并发窗口。
     */
    private async treeSlotBitmap(size: number): Promise<{ have: number; slots: boolean[] }> {
        const p = this.treePath(size);
        let stat: import('fs').Stats;
        try {
            stat = await fs.stat(p);
        } catch {
            return { have: 0, slots: [] };
        }
        const cached = this.treeSlotCache.get(size);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileSize === stat.size) {
            return { have: Math.floor(stat.size / TREE_REC), slots: cached.slots };
        }
        const have = Math.floor(stat.size / TREE_REC);
        const slots: boolean[] = [];
        let cacheable = true;
        if (have > 0) {
            let buf: Buffer;
            try {
                buf = await fs.readFile(p);
            } catch {
                // 文件在 stat 后被删除/不可读：按无槽处理（与 stat 失败同款防御），
                // 不缓存——下次调用按新 stat 重新构建。
                return { have: 0, slots: [] };
            }
            // 二次 stat 校验：stat→readFile 窗口内写路径可能已改写文件并失效缓存，
            // 若仍按写前 stat 值回填，会在失效后把陈旧位图写回缓存（陈旧位图窗口——
            // 粗粒度 mtime 下后续读会长期命中错误位图）。读取期间文件变化 →
            // 本次结果不缓存，下次调用按新 stat 重新构建。
            try {
                const stat2 = await fs.stat(p);
                cacheable = stat2.mtimeMs === stat.mtimeMs && stat2.size === stat.size;
            } catch {
                cacheable = false; // 文件被删除/重命名：不缓存
            }
            for (let k = 0; k < have; k++) {
                const slice = buf.subarray(k * TREE_REC, (k + 1) * TREE_REC);
                slots.push(slice.toString('utf-8').trimEnd().length > 0);
            }
        }
        if (cacheable) {
            this.treeSlotCache.set(size, { mtimeMs: stat.mtimeMs, fileSize: stat.size, slots });
        }
        return { have, slots };
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
                this.treeCacheInvalidate(size);
                size *= 2;
            }
            return gone;
        } finally {
            release();
        }
    }

    /** 列出所有待构建的块（最小优先） */
    async pending(T: number, limit?: number): Promise<Array<[number, number]>> {
        const todo: Array<[number, number]> = [];
        let size = 2;
        while (size <= T) {
            // 整文件槽位位图一次读取 + 缓存复用（treeSlotBitmap），
            // 替代逐槽 treeGet 的 O(T) 次 open/read/close 文件句柄循环
            const { have, slots } = await this.treeSlotBitmap(size);
            const maxK = Math.floor(T / size);
            // count 只反映「文件里有多少个槽位」，不能反映「哪些槽位有内容」：
            // treeDrop 会把中间槽位写成空记录（保留索引供 treePut 复用），
            // 空槽从未被压缩，必须重新进入待压缩队列。
            // k >= have 的槽位从未写入，直接视为待压缩（保持原有 count 语义）；
            // k < have 的槽位逐槽判空，空槽同样视为待压缩。
            for (let k = 0; k < maxK; k++) {
                if (k < have && slots[k]) continue; // 已有摘要
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
            const { have, slots } = await this.treeSlotBitmap(size);
            const maxK = Math.floor(T / size);
            // 与 pending() 同口径：[have, maxK) 从未写入全部待压缩；
            // [0, have) 内 treeDrop 留下的空记录也算待压缩
            let pendingBlocks = Math.max(0, maxK - have);
            for (let k = 0; k < have && k < maxK; k++) {
                if (!slots[k]) pendingBlocks++;
            }
            n += pendingBlocks;
            size *= 2;
        }
        return n;
    }

    /**
     * updateEntry: 原地覆写单条原始记忆的文本。
     * 新文本必须不超过固定宽度（LOG_REC - 1 字节，即 1023 字节）。
     */
    async updateEntry(id: number, text: string): Promise<void> {
        const entryChars = this.getConfig().entryChars;
        const trimmed = text.trim();
        if (!trimmed) die('Empty. A memory is one line of text.');
        if (trimmed.includes('\n') || trimmed.includes('\r')) {
            die('A memory is one line.');
        }
        const byteLen = Buffer.byteLength(trimmed, 'utf-8');
        if (byteLen > entryChars) {
            die(`Too long: ${byteLen} bytes, limit ${entryChars}.`);
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
        // 声明在 try 外：return 位于 try/finally 块之后，块内 const 会脱离作用域；
        // 默认值取请求区间长度，实际值在扫描结束后按跳过记录数修正
        let actualRemoved = hi - lo + 1;
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
            // 区间内实际被跳过的空/损坏记录数：这些记录本就不存在/不可读，删除条数
            // 与 newT 推演必须扣除它们，否则会与实际写回 tmp 的条数分叉（见下方）
            let skippedInRange = 0;
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
                        const inRange = idx >= lo && idx <= hi;
                        // 遇空记录（损坏文件中的空洞）跳过而不是 break：保留其后仍有效的记录
                        if (!str) {
                            if (inRange) skippedInRange++;
                            continue;
                        }
                        const parsed = parse(str);
                        if (!parsed) {
                            // B-9: 损坏行跳过（不重建），与 records() 解析口径一致；
                            // 区间内的损坏行计入「跳过」：实际删除数按真实可删记录统计
                            if (inRange) skippedInRange++;
                            continue;
                        }
                        if (inRange) continue;
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
            // 实际删除数 = 请求区间 - 区间内空/损坏记录：按真实条数推演 newT 与返回值，
            // 保证与写回 tmp 的条数（= 后续 logLen()）一致，树摘要保留边界不错位
            actualRemoved = (hi - lo + 1) - skippedInRange;
            const newT = T - actualRemoved;
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
                    this.treeCacheInvalidate(size);
                }
            }

            // 读/写句柄已关闭后再 rename：Windows 下目标文件被占用时 rename 会 EPERM。
            // tmp+rename 原子替换，崩溃不损坏线上文件。
            await fs.rename(tmpPath, logPath);
        } finally {
            release();
        }

        return { removed: actualRemoved };
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
            // 目标 id 集合内实际被跳过的空/损坏记录数（与 deleteRange 同口径）：
            // 删除条数与 newT 推演必须扣除它们，保证与写回 tmp 的条数一致
            let skippedInRange = 0;
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
                        const inTarget = toDelete.has(idx);
                        // 空/损坏记录跳过语义与 deleteRange 一致；目标 id 内的空/损坏记录
                        // 计入「跳过」，实际删除数按真实可删记录统计
                        if (!str) {
                            if (inTarget) skippedInRange++;
                            continue;
                        }
                        const parsed = parse(str);
                        if (!parsed) {
                            if (inTarget) skippedInRange++;
                            continue;
                        }
                        if (inTarget) continue;
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
            // 实际删除数扣除目标 id 内的空/损坏记录（同 deleteRange 口径）
            const actualRemoved = sorted.length - skippedInRange;
            const newT = T - actualRemoved;
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
                    this.treeCacheInvalidate(size);
                }
            }

            // 树清理完成后原子换 LOG（顺序与 deleteRange 一致：先清树、后换 LOG）
            await fs.rename(tmpPath, logPath);
            return { removed: actualRemoved };
        } finally {
            release();
        }
    }

    /** 丢弃所有覆盖给定 ID 的树摘要（编辑记忆后调用） */
    async dropSummariesCovering(id: number): Promise<void> {
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
            // 必须先 repairLog 再 logLen：旧格式（OLD_LOG_REC=320B/条）文件在迁移前
            // logLen 按当前 logRecMode（默认 LOG_REC=1024）计数会低估 T——keepId >= T
            // 提前 return、removed 数值错误、树清理循环截不断旧摘要导致记忆「复活」。
            // 其余写路径（logAppend/updateEntry/deleteRange/deleteEntries）均为
            // repairLog 在前、logLen 在后，此处与之一致。
            const logPath = this.logPath();
            await this.repairLog(); // 打开前修复：旧格式迁移 + 撕裂尾截断
            const T = await this.logLen();
            if (keepId >= T) {
                return { removed: 0 };
            }
            // 1. 截断 LOG 文件
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
                    this.treeCacheInvalidate(size);
                }
                size *= 2;
            }

            return { removed: T - keepId };
        } finally {
            release();
        }
    }
}
