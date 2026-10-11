/**
 * MemoryEngine 回归测试：
 * 1. compress 仅在 treePut 成功时置 said=true（块已存在/并行会话已处理时不误报 done:1）
 * 2. wake 缺失摘要时基于实际缺失的块构造提示（而非 nextNap 的第一个待压缩块）
 * 3. 普通待压缩提示与阻塞 wake 的必要压缩具有不同紧迫度
 */
import { memoryEngineFixture } from '../support/memoryEngine';


describe('MemoryEngine.compress', () => {
    async function setup8() {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        
        await mm.init();
        for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
            await mm.note(t);
        }
        return { mm, cleanup };
    }

    test('块已存在（非下一个待压缩块）时 done=0，不误报已写入', async () => {
        const { mm, cleanup } = await setup8();
        try {
            expect((await mm.compress('0-1', 'ab')).done).toBe(1);
            expect((await mm.compress('2-3', 'cd')).done).toBe(1);
            expect((await mm.compress('4-5', 'ef')).done).toBe(1);
            expect((await mm.compress('6-7', 'gh')).done).toBe(1);
            expect((await mm.compress('0-3', 'abcd')).done).toBe(1);
            expect((await mm.compress('4-7', 'efgh')).done).toBe(1);

            // 现在待压缩的是 [0,8)：再次压缩已存在的 4-7 不应上报 done:1
            const again = await mm.compress('4-7', 'EFGH');
            expect(again.done).toBe(0);
            expect(again.pendingCompression?.blockId).toBe('0-7');
        } finally {
            await cleanup();
        }
    });

    test('只传 blockId 时明确拒绝缺失的 summary', async () => {
        const { mm, cleanup } = await setup8();
        try {
            await expect(mm.compress('0-1')).rejects.toThrow('summary is required');
        } finally {
            await cleanup();
        }
    });

    test('treePut 返回 false（并行会话已处理）时 done=0', async () => {
        const { mm, cleanup } = await setup8();
        try {
            jest.spyOn(mm as any, 'treePut').mockResolvedValue(false);
            const result = await mm.compress('0-1', 'ab');
            expect(result.done).toBe(0);
            expect(result.pendingCompression).not.toBeNull();
        } finally {
            await cleanup();
        }
    });

    test('note 返回的待压缩任务是可延后维护，不要求打断当前任务', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        try {
            
            await mm.init();
            await mm.note('durable preference one');
            const result = await mm.note('durable preference two');

            expect(result.pendingCompression?.required).toBe(false);
            expect(result.pendingCompression?.prompt).toContain('Deferred maintenance');
            expect(result.pendingCompression?.prompt).toContain('finish the current deliverable first');
        } finally {
            await cleanup();
        }
    });
});

describe('MemoryEngine 压缩提示节流', () => {
    test('待压缩状态未变化时 note 不重复提示', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        try {
            
            await mm.init();
            await mm.note('a');
            // T=2：出现首个待压缩块 [0,2) → 首次提示
            const first = await mm.note('b');
            expect(first.pendingCompression?.blockId).toBe('0-1');
            // T=3：待压缩集合仍是 [0,2)（数量与最老块均未变）→ 不重复提示
            const second = await mm.note('c');
            expect(second.pendingCompression).toBeUndefined();
            // T=4：新增 [2,4)，待压缩数量 1 → 2 → 状态变化，再次提示
            const third = await mm.note('d');
            expect(third.pendingCompression?.blockId).toBe('0-1');
        } finally {
            await cleanup();
        }
    });

    test('compress 后紧接着的 note 不重复同一提示', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        try {
            
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd']) await mm.note(t);
            const compressed = await mm.compress('0-1', 'ab');
            expect(compressed.done).toBe(1);
            expect(compressed.pendingCompression).toBeTruthy();
            // compress 已返回下一段提示（并记录签名）：note 不重复同一状态
            const next = await mm.note('e');
            expect(next.pendingCompression).toBeUndefined();
        } finally {
            await cleanup();
        }
    });

    test('wake 提示后紧接着的 note 不重复同一提示', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280 } as any);
        try {
            
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            // wake 是会话入口：总是返回提示
            const wake = await mm.wake();
            expect(wake.pendingCompression?.blockId).toBe('0-1');
            const next = await mm.note('c');
            expect(next.pendingCompression).toBeUndefined();
        } finally {
            await cleanup();
        }
    });
});

describe('MemoryEngine.wake', () => {
    test('缺失摘要时提示基于实际缺失的块构造（而非第一个待压缩块）', async () => {
        const { engine: mm, cleanup } = await memoryEngineFixture({ entryChars: 280, wakeLines: 2 } as any);
        try {
            
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
                await mm.note(t);
            }
            // 只压缩 0-1：pending 的第一个是 [2,4)，但 wake 缺失的块是 [0,4)
            await mm.compress('0-1', 'ab');

            const error = await mm.wake(undefined, 8).catch(e => e);
            expect(error.message).toContain('needs #0-3');
            // 提示必须指向实际缺失的块 0-3，而不是第一个待压缩块 2-3
            expect(error.message).toContain('Compress memories #0-3');
            expect(error.message).toContain('required before engineering_log action=wake can finish');
            expect(error.message).not.toContain('Deferred maintenance');
            expect(error.message).not.toContain('Compress memories #2-3');
        } finally {
            await cleanup();
        }
    });
});
