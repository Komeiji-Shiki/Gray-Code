/**
 * MemoryManager.deleteRange / deleteEntries 回归测试：
 * 1. 闭区间删除：仅移除 [lo, hi]，其后的记录 id 前移、文本/日期保留
 * 2. 单点区间（lo === hi）等价单条删除
 * 3. 删除整段（含端点）后追加：新记录 id 连续无冲突
 * 4. 非法区间（越界 / lo > hi）抛错且不改变数据
 * 5. 批量删除（乱序/重复 id）：按闭区间聚合，全部移除、其余重编号
 * 6. 删除后树摘要被清空
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';

function setup(): { mm: MemoryManager; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-delete-range-'));
    const mm = new MemoryManager(dir, { entryChars: 280 } as any);
    return { mm, dir };
}

describe('MemoryManager.deleteRange', () => {
    it('闭区间删除：仅移除 [lo, hi]，其后记录 id 前移、文本与日期保留', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e']) {
                await mm.note(t);
            }

            const result = await mm.deleteRange(1, 3);
            expect(result.removed).toBe(3);

            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1]);
            expect(entries.map(e => e.text)).toEqual(['a', 'e']);
            expect(entries[1].date).toBeTruthy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('单点区间（lo === hi）等价单条删除', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c']) {
                await mm.note(t);
            }
            await mm.deleteRange(1, 1);
            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1]);
            expect(entries.map(e => e.text)).toEqual(['a', 'c']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除首部整段后追加：新记录 id 连续无冲突', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd']) {
                await mm.note(t);
            }
            await mm.deleteRange(0, 2); // 剩 [d] → id 0
            const noteResult = await mm.note('e'); // 应追加为 id 1
            expect(noteResult.id).toBe(1);
            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1]);
            expect(entries.map(e => e.text)).toEqual(['d', 'e']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('非法区间：越界 / lo > hi 抛错且不改变数据', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.note('c');

            await expect(mm.deleteRange(-1, 1)).rejects.toThrow('No memory at index');
            await expect(mm.deleteRange(1, 3)).rejects.toThrow('No memory at index');
            await expect(mm.deleteRange(2, 1)).rejects.toThrow('No memory at index');
            const entries = await mm.listEntries();
            expect(entries).toHaveLength(3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除覆盖块的树摘要被清空（中间删除全清）', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['m1', 'm2', 'm3', 'm4']) {
                await mm.note(t);
            }
            await (mm as any).treePut(0, 4, 'summary of all');

            await mm.deleteRange(1, 2);
            const summary = await (mm as any).treeGet(0, 4);
            expect(summary).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('非法参数：非整数 / NaN 抛错且不改变数据', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');

            await expect(mm.deleteRange(NaN, 1)).rejects.toThrow('Invalid delete range');
            await expect(mm.deleteRange(0, NaN)).rejects.toThrow('Invalid delete range');
            await expect(mm.deleteRange(1.5, 1.5)).rejects.toThrow('Invalid delete range');
            const entries = await mm.listEntries();
            expect(entries).toHaveLength(2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('deleteEntries：非数组 / 非法 id 抛错且不改变数据', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.note('c');

            await expect((mm as any).deleteEntries('not-array')).rejects.toThrow('ids must be an array');
            await expect(mm.deleteEntries([0, -1])).rejects.toThrow('ids must be non-negative integers');
            await expect(mm.deleteEntries([0, 1.5])).rejects.toThrow('ids must be non-negative integers');
            const entries = await mm.listEntries();
            expect(entries).toHaveLength(3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager.deleteEntries', () => {
    it('乱序/重复 id：全部移除，其余记录重编号', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e']) {
                await mm.note(t);
            }
            const result = await mm.deleteEntries([3, 1, 1, 4]); // 删 1, 3, 4（去重）
            expect(result.removed).toBe(3);

            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1]);
            expect(entries.map(e => e.text)).toEqual(['a', 'c']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('相邻 id 聚合为闭区间删除', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) {
                await mm.note(t);
            }
            const result = await mm.deleteEntries([1, 2, 5]); // 区间 [1,2] 与 [5,5]
            expect(result.removed).toBe(3);

            const entries = await mm.listEntries();
            expect(entries.map(e => e.text)).toEqual(['a', 'd', 'e']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('空数组返回 removed 0 且不改变数据', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            const result = await mm.deleteEntries([]);
            expect(result.removed).toBe(0);
            expect(await mm.listEntries()).toHaveLength(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除后继续追加：id 连续无冲突', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd']) {
                await mm.note(t);
            }
            await mm.deleteEntries([0, 2]);
            const noteResult = await mm.note('e');
            expect(noteResult.id).toBe(2);
            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
            expect(entries.map(e => e.text)).toEqual(['b', 'd', 'e']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
