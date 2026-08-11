/**
 * LOG 旧格式（320B/条）→ 新格式（LOG_REC=1024B/条）迁移回归测试：
 * 1. 旧格式文件打开后数据无损（文本/日期/id 完整），文件被重写为新格式（1024 对齐）
 * 2. 迁移幂等：首次访问触发一次原子替换，再次访问不重复重写
 * 3. 旧格式 + 撕裂尾巴：完整记录无损迁移，尾巴被丢弃
 * 4. 新格式文件不受影响（不触发重写，字节不变）
 * 5. 歧义尺寸（5120 = 16×320 = 5×1024）：内容判别，旧格式正确迁移
 * 6. 320 对齐但内容非旧格式（垃圾）：不迁移、不抛错（fail-open），文件保持原样
 * 7. 迁移后 wake/recall 输出完整
 * 8. 迁移后可正常追加/编辑/删除
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';
import { LOG_REC } from '../../modules/memory/types';

// 旧格式固定宽度（迁移前的 LOG_REC=320）
const OLD_REC = 320;

/** 构造一条旧格式记录（320B：「#id date text」+ 空格填充 + 换行） */
function oldRecord(id: number, date: string, text: string): Buffer {
    const rec = Buffer.alloc(OLD_REC);
    const line = Buffer.from(`#${id} ${date} ${text}`, 'utf-8');
    if (line.length > OLD_REC - 1) throw new Error(`fixture too long: ${line.length} bytes`);
    line.copy(rec);
    rec.fill(0x20, line.length, OLD_REC - 1);
    rec[OLD_REC - 1] = 0x0a;
    return rec;
}

/** 构造旧格式 LOG 文件（创建目录 + LOG.txt），可选追加撕裂尾巴，返回目录 */
function makeOldLog(texts: string[], tail?: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrate-'));
    const records = texts.map((t, i) => oldRecord(i, '2024-01-01', t));
    fs.writeFileSync(path.join(dir, 'LOG.txt'), Buffer.concat([...records, ...(tail ? [tail] : [])]));
    return dir;
}

/** 以新宽度（LOG_REC）解析 LOG 文件全部记录，供断言迁移结果 */
function readNewFormat(dir: string): Array<{ id: number; date: string; text: string }> {
    const buf = fs.readFileSync(path.join(dir, 'LOG.txt'));
    const out: Array<{ id: number; date: string; text: string }> = [];
    for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
        const str = buf.subarray(i, i + LOG_REC).toString('utf-8').trimEnd();
        if (!str) continue;
        const m = str.match(/^#(\d+) (\S+) (.+)$/);
        if (m) out.push({ id: parseInt(m[1], 10), date: m[2], text: m[3] });
    }
    return out;
}

describe('MemoryManager LOG 旧格式迁移', () => {
    it('旧格式文件：打开后数据无损（含多字节文本），文件被重写为新格式', async () => {
        const texts = ['alpha', 'x'.repeat(270), '记忆-β'];
        const dir = makeOldLog(texts);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            const entries = await mm.listEntries(); // 读取触发迁移
            expect(entries.map(e => e.text)).toEqual(texts);
            expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
            expect(entries.every(e => e.date === '2024-01-01')).toBe(true);

            // 文件已重写为新格式：1024 对齐、非 320 对齐，且内容按新宽度可完整解析
            const buf = fs.readFileSync(path.join(dir, 'LOG.txt'));
            expect(buf.length % LOG_REC).toBe(0);
            expect(buf.length % OLD_REC).not.toBe(0);
            const parsed = readNewFormat(dir);
            expect(parsed.map(e => e.text)).toEqual(texts);
            expect(parsed.map(e => e.id)).toEqual([0, 1, 2]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('迁移幂等：首次访问触发一次原子替换，再次访问不重复重写', async () => {
        const dir = makeOldLog(['a', 'b']);
        try {
            // 通过 require 拿到底层 CJS 模块对象（与 memoryManagerFixes.test.ts 同法）
            const fsPromises = require('fs/promises') as typeof import('fs/promises');
            const realRename = fsPromises.rename;
            const renameSpy = jest.spyOn(fsPromises, 'rename').mockImplementation(async (...args: any[]) => {
                return (realRename as any)(...(args as [any, any]));
            });
            try {
                const mm = new MemoryManager(dir);
                await mm.init();
                await mm.listEntries(); // 第一次：迁移（rename 一次）
                const sizeAfterFirst = fs.statSync(path.join(dir, 'LOG.txt')).size;
                expect(sizeAfterFirst).toBe(2 * LOG_REC);
                await mm.wake();        // 第二次：不应再重写
                await mm.totalEntries();
                expect(fs.statSync(path.join(dir, 'LOG.txt')).size).toBe(sizeAfterFirst);
                expect(renameSpy).toHaveBeenCalledTimes(1);
            } finally {
                renameSpy.mockRestore();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('旧格式 + 撕裂尾巴：完整记录无损迁移，撕裂尾巴被丢弃', async () => {
        const dir = makeOldLog(['a', 'b'], Buffer.from('partial-garbage-tail'));
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            const entries = await mm.listEntries();
            expect(entries.map(e => e.text)).toEqual(['a', 'b']);
            const buf = fs.readFileSync(path.join(dir, 'LOG.txt'));
            expect(buf.length % LOG_REC).toBe(0);
            expect(readNewFormat(dir).map(e => e.text)).toEqual(['a', 'b']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('新格式文件不受影响（不触发重写，字节不变）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrate-'));
        try {
            const fsPromises = require('fs/promises') as typeof import('fs/promises');
            const realRename = fsPromises.rename;
            const renameSpy = jest.spyOn(fsPromises, 'rename').mockImplementation(async (...args: any[]) => {
                return (realRename as any)(...(args as [any, any]));
            });
            try {
                const mm = new MemoryManager(dir);
                await mm.init();
                await mm.note('hello');
                await mm.note('world');
                const before = fs.readFileSync(path.join(dir, 'LOG.txt'));
                await mm.listEntries();
                await mm.wake();
                expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(before)).toBe(true);
                expect(renameSpy).not.toHaveBeenCalled();
            } finally {
                renameSpy.mockRestore();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('歧义尺寸（5120 = 16×320 = 5×1024）：内容判别，旧格式正确迁移', async () => {
        const texts = Array.from({ length: 16 }, (_, i) => `memory-${i}`);
        const dir = makeOldLog(texts); // 16 条 × 320 = 5120，同时是 320 与 1024 的倍数
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            const entries = await mm.listEntries();
            expect(entries.map(e => e.text)).toEqual(texts);
            const buf = fs.readFileSync(path.join(dir, 'LOG.txt'));
            expect(buf.length).toBe(16 * LOG_REC);
            expect(readNewFormat(dir).map(e => e.text)).toEqual(texts);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('320 对齐但内容非旧格式（垃圾）：不迁移、不抛错（fail-open）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrate-'));
        try {
            const garbage = Buffer.alloc(320, 0x58); // 'X' × 320
            fs.writeFileSync(path.join(dir, 'LOG.txt'), garbage);
            const mm = new MemoryManager(dir);
            await mm.init();
            const entries = await mm.listEntries(); // 不抛错
            expect(entries).toHaveLength(0);
            // 文件未被改动
            expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(garbage)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('迁移后 wake/recall 输出完整', async () => {
        const dir = makeOldLog(['alpha-1', 'beta-2', 'alpha-3']);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            const wake = await mm.wake();
            expect(wake.totalMemories).toBe(3);
            expect(wake.blocks.map(b => b.text.slice(11))).toEqual(['alpha-1', 'beta-2', 'alpha-3']);
            const recall = await mm.recall('alpha');
            expect(recall.totalHits).toBe(2);
            expect(recall.lines.map(l => l.split(' ').slice(2).join(' '))).toEqual(['alpha-1', 'alpha-3']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('迁移后可正常追加/编辑/删除', async () => {
        const dir = makeOldLog(['a', 'b', 'c']);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            await mm.listEntries(); // 迁移
            const { id } = await mm.note('d');
            expect(id).toBe(3);
            await mm.updateEntry(0, 'A');
            expect((await mm.listEntries()).map(e => e.text)).toEqual(['A', 'b', 'c', 'd']);
            await mm.deleteEntry(1);
            expect((await mm.listEntries()).map(e => e.text)).toEqual(['A', 'c', 'd']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
