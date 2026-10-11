/**
 * MemoryEngine 手动新增/记录容量/截断读取回归测试：
 * 1. note 的多行/超容量校验（含固定宽度记录头部开销的精确校验）
 * 2. updateEntry 的整条记录容量校验
 * 3. totalEntries / listEntries(limit) 截断语义
 * 4. wake 连续原始块批量读取后输出与逐块读取一致
 */
import { memoryEngineFixture } from '../support/memoryEngine';
import { LOG_REC } from '../../../../backend/modules/memory/types';
import { MAX_ENTRY_CHARS } from '../../../../backend/modules/memory/logFormat';

describe('MemoryEngine.note 手动新增', () => {
    test('entryChars 可调高到 1280 并写入 1280 字节文本（不再被旧上限 1000 拒绝）', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({});
        try {
            
            await mm.init();
            // 旧实现的 entryChars 上限为 1000，1280 会报 "Invalid entryChars"
            const cfg = await mm.updateConfig({ entryChars: 1280 });
            expect(cfg.entryChars).toBe(1280);

            const text = 'x'.repeat(1280);
            const { id } = await mm.note(text);
            expect(id).toBe(0);
            expect((await mm.listEntries())[0].text).toBe(text);

            // 超过记录容量硬上限仍在 updateConfig 处被明确拒绝
            await expect(mm.updateConfig({ entryChars: MAX_ENTRY_CHARS + 1 }))
                .rejects.toThrow(/Must be an integer between 1 and \d+/);
        } finally {
            await cleanup();
        }
    });
    test('拒绝多行文本', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        try {
            
            await mm.init();
            await expect(mm.note('line1\nline2')).rejects.toThrow('one line');
            expect(await mm.totalEntries()).toBe(0);
        } finally {
            await cleanup();
        }
    });

    test('按整条固定宽度记录校验（头部 + 文本），拒绝超出记录预算的文本', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: LOG_REC - 1 } as any);
        try {
            // entryChars 故意设到记录理论上限（LOG_REC - 1）：仅校验文本长度会放行
            // LOG_REC - 13 字节的文本（id=0 时头部 "#0 <date> " 占 14 字节），
            // 但整条记录超出 LOG_REC - 1，应在 assertRecordFits 处以清晰的 budget
            // 信息拒绝，而不是在 pad() 处报错。
            
            await mm.init();
            await expect(mm.note('x'.repeat(LOG_REC - 13))).rejects.toThrow(/Too long.*budget/);
            expect(await mm.totalEntries()).toBe(0);
            // 预算内的文本正常写入
            await mm.note('x'.repeat(200));
            expect(await mm.totalEntries()).toBe(1);
        } finally {
            await cleanup();
        }
    });
});

describe('MemoryEngine.updateEntry 容量校验', () => {
    test('拒绝使整条记录超宽的编辑', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: LOG_REC - 1 } as any);
        try {
            // 同 note 用例：entryChars 设到记录理论上限，文本取 LOG_REC - 13 字节
            // （id=0 时头部 14 字节，整条记录超出 LOG_REC - 1 的容量预算）
            
            await mm.init();
            const { id } = await mm.note('short');
            await expect(mm.updateEntry(id, 'y'.repeat(LOG_REC - 13))).rejects.toThrow(/Too long.*budget/);
            // 失败后原内容保持不变
            const entries = await mm.listEntries();
            expect(entries[0].text).toBe('short');
        } finally {
            await cleanup();
        }
    });
});

describe('MemoryEngine.totalEntries / listEntries(limit)', () => {
    test('listEntries(limit) 只返回前 N 条，totalEntries 给出全量计数', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({});
        try {
            
            await mm.init();
            for (let i = 0; i < 10; i++) {
                await mm.note(`memory-${i}`);
            }
            expect(await mm.totalEntries()).toBe(10);
            expect((await mm.listEntries(3)).map(e => e.text)).toEqual(['memory-0', 'memory-1', 'memory-2']);
            expect((await mm.listEntries()).length).toBe(10);
        } finally {
            await cleanup();
        }
    });
});

describe('MemoryEngine.wake 批量读取', () => {
    test('连续原始块合并读取后输出与逐块读取一致（顺序与内容不变）', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ wakeLines: 100 } as any);
        try {
            
            await mm.init();
            for (const text of ['a', 'b', 'c', 'd', 'e']) {
                await mm.note(text);
            }
            const result = await mm.wake();
            expect(result.totalMemories).toBe(5);
            expect(result.blocks.map(b => b.text.slice(11))).toEqual(['a', 'b', 'c', 'd', 'e']);
            expect(result.blocks.every(b => b.isRaw)).toBe(true);
        } finally {
            await cleanup();
        }
    });
});
