/**
 * MemoryManager.deleteEntry 回归测试：
 * 1. 删除中间条目：仅该条被移除，其后的记录 id 前移一格、文本/日期保留（真·单条删除，不连坐）
 * 2. 删除最后一条：后续 id 不变
 * 3. 删除唯一一条：LOG 清空
 * 4. 非法 id（越界 / 负数）抛错
 * 5. 删除后树摘要被清空（覆盖块的下层文件被截断）
 * 6. 删除后继续 note 追加：新记录 id 连续无冲突
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';

function setup(): { mm: MemoryManager; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-delete-entry-'));
    const mm = new MemoryManager(dir, { entryChars: 280 } as any);
    return { mm, dir };
}

describe('MemoryManager.deleteEntry', () => {
    it('删除中间条目：仅该条被移除，其后记录 id 前移、文本与日期保留', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('first');
            await mm.note('second');
            await mm.note('third');
            await mm.note('fourth');

            // 删除 id=1（second）：其余 3 条保留，id 重编号为 0,1,2
            const result = await mm.deleteEntry(1);
            expect(result.removed).toBe(1);

            const entries = await mm.listEntries();
            expect(entries).toHaveLength(3);
            expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
            expect(entries.map(e => e.text)).toEqual(['first', 'third', 'fourth']);
            // 日期保留（非空且与删除前一致）
            expect(entries[1].date).toBeTruthy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除最后一条：后续 id 不变', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.note('c');

            await mm.deleteEntry(2);
            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1]);
            expect(entries.map(e => e.text)).toEqual(['a', 'b']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除唯一一条：LOG 清空', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('only');

            await mm.deleteEntry(0);
            const entries = await mm.listEntries();
            expect(entries).toHaveLength(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('非法 id：负数 / 越界抛错且不改变数据', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');

            await expect(mm.deleteEntry(-1)).rejects.toThrow('No memory at index');
            await expect(mm.deleteEntry(2)).rejects.toThrow('No memory at index');
            const entries = await mm.listEntries();
            expect(entries).toHaveLength(2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除后继续追加：新记录 id 连续无冲突', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.note('c');

            await mm.deleteEntry(0); // 剩 [b, c] → id 0,1
            const noteResult = await mm.note('d'); // 应追加为 id 2
            expect(noteResult.id).toBe(2);

            const entries = await mm.listEntries();
            expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
            expect(entries.map(e => e.text)).toEqual(['b', 'c', 'd']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('删除中间条目后树摘要被清空（覆盖块的树文件被截断）', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['m1', 'm2', 'm3', 'm4']) {
                await mm.note(t);
            }
            // 构造一个覆盖全部 [0,4) 的树摘要（size=4 块）
            await (mm as any).treePut(0, 4, 'summary of all');

            await mm.deleteEntry(1);
            // 删除后 id 变号：全部树摘要清空，treeGet 返回 null
            const summary = await (mm as any).treeGet(0, 4);
            expect(summary).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
