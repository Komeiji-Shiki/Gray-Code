/**
 * MemoryManager 手动新增/记录容量/截断读取回归测试：
 * 1. note 的多行/超容量校验（含固定宽度记录头部开销的精确校验）
 * 2. updateEntry 的整条记录容量校验
 * 3. totalEntries / listEntries(limit) 截断语义
 * 4. 撕裂尾部记录（崩溃残留）不再被解析为有效条目
 * 5. wake 连续原始块批量读取后输出与逐块读取一致
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';
import { LOG_REC } from '../../modules/memory/types';

describe('MemoryManager.note 手动新增', () => {
    it('拒绝多行文本', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-note-'));
        try {
            const mm = new MemoryManager(dir, { entryChars: 280 } as any);
            await mm.init();
            await expect(mm.note('line1\nline2')).rejects.toThrow('one line');
            expect(await mm.totalEntries()).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('按整条固定宽度记录校验（头部 + 文本），拒绝超出记录预算的文本', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-note-'));
        try {
            // entryChars 故意设到记录理论上限（LOG_REC - 1）：仅校验文本长度会放行
            // LOG_REC - 13 字节的文本（id=0 时头部 "#0 <date> " 占 14 字节），
            // 但整条记录超出 LOG_REC - 1，应在 assertRecordFits 处以清晰的 budget
            // 信息拒绝，而不是在 pad() 处报错。
            const mm = new MemoryManager(dir, { entryChars: LOG_REC - 1 } as any);
            await mm.init();
            await expect(mm.note('x'.repeat(LOG_REC - 13))).rejects.toThrow(/Too long.*budget/);
            expect(await mm.totalEntries()).toBe(0);
            // 预算内的文本正常写入
            await mm.note('x'.repeat(200));
            expect(await mm.totalEntries()).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager.updateEntry 容量校验', () => {
    it('拒绝使整条记录超宽的编辑', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-update-'));
        try {
            // 同 note 用例：entryChars 设到记录理论上限，文本取 LOG_REC - 13 字节
            // （id=0 时头部 14 字节，整条记录超出 LOG_REC - 1 的容量预算）
            const mm = new MemoryManager(dir, { entryChars: LOG_REC - 1 } as any);
            await mm.init();
            const { id } = await mm.note('short');
            await expect(mm.updateEntry(id, 'y'.repeat(LOG_REC - 13))).rejects.toThrow(/Too long.*budget/);
            // 失败后原内容保持不变
            const entries = await mm.listEntries();
            expect(entries[0].text).toBe('short');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager.totalEntries / listEntries(limit)', () => {
    it('listEntries(limit) 只返回前 N 条，totalEntries 给出全量计数', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-list-'));
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            for (let i = 0; i < 10; i++) {
                await mm.note(`memory-${i}`);
            }
            expect(await mm.totalEntries()).toBe(10);
            expect((await mm.listEntries(3)).map(e => e.text)).toEqual(['memory-0', 'memory-1', 'memory-2']);
            expect((await mm.listEntries()).length).toBe(10);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager 撕裂尾部记录', () => {
    it('崩溃残留的半条记录不被解析为有效条目，下一次追加时被 repair 修复', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tail-'));
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            // 模拟崩溃：向日志末尾追加不足 LOG_REC 字节的垃圾（部分写入）
            const logPath = path.join(dir, 'LOG.txt');
            fs.appendFileSync(logPath, Buffer.from('partial-garbage-tail'));
            // 修复前读取：不应把撕裂尾巴解析为有效条目
            const entries = await mm.listEntries();
            expect(entries.length).toBe(2);
            // 下一次追加触发 repair 截断残留尾巴，日志恢复为整条记录
            await mm.note('c');
            const after = await mm.listEntries();
            expect(after.length).toBe(3);
            expect(after.map(e => e.text)).toEqual(['a', 'b', 'c']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager.wake 批量读取', () => {
    it('连续原始块合并读取后输出与逐块读取一致（顺序与内容不变）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wake-batch-'));
        try {
            const mm = new MemoryManager(dir, { wakeLines: 100 } as any);
            await mm.init();
            for (const text of ['a', 'b', 'c', 'd', 'e']) {
                await mm.note(text);
            }
            const result = await mm.wake();
            expect(result.totalMemories).toBe(5);
            expect(result.blocks.map(b => b.text.slice(11))).toEqual(['a', 'b', 'c', 'd', 'e']);
            expect(result.blocks.every(b => b.isRaw)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
