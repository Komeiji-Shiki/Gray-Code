/**
 * memory_forget 工具回归测试（三种模式）：
 * 1. 单个数字 ID（如 "5"）：只删除这一条原始记忆，其余保留、id 前移重编号
 * 2. 闭区间（如 "1,3"）：删除 ID 1 到 3 的所有原始记忆
 * 3. 块 ID（如 "0-3"）：只丢弃树摘要，原始记忆不被触碰
 * 4. 非法参数（未初始化 / 越界）返回失败结果而非抛异常
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager, setGlobalMemoryManager } from '../../modules/memory';
import { createMemoryForgetTool } from '../../tools/memory/memory_forget';

function setup(): { mm: MemoryManager; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tool-forget-'));
    const mm = new MemoryManager(dir, { entryChars: 280 } as any);
    return { mm, dir };
}

async function runTool(blockId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const tool = createMemoryForgetTool();
    return await tool.handler({ blockId }, undefined as any) as any;
}

describe('memory_forget 工具', () => {
    afterEach(() => {
        setGlobalMemoryManager(null as any);
    });

    it('单 ID：只删除这一条，其余保留并重编号', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd']) {
                await mm.note(t);
            }
            setGlobalMemoryManager(mm);

            const result = await runTool('1');
            expect(result.success).toBe(true);
            expect(result.data.removed).toBe(1);
            expect(result.data.message).toContain('#1');

            const entries = await mm.listEntries();
            expect(entries.map(e => e.text)).toEqual(['a', 'c', 'd']);
            expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('闭区间：删除 1 到 3 的所有记忆（含端点）', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e']) {
                await mm.note(t);
            }
            setGlobalMemoryManager(mm);

            const result = await runTool('1,3');
            expect(result.success).toBe(true);
            expect(result.data.removed).toBe(3);

            const entries = await mm.listEntries();
            expect(entries.map(e => e.text)).toEqual(['a', 'e']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('块 ID：只丢弃树摘要，原始记忆不被触碰', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            for (const t of ['m1', 'm2', 'm3', 'm4']) {
                await mm.note(t);
            }
            setGlobalMemoryManager(mm);
            await (mm as any).treePut(0, 4, 'summary of all');

            const result = await runTool('0-3');
            expect(result.success).toBe(true);
            expect(result.data.gone).toBe(1);

            // 原始记忆完好
            expect(await mm.listEntries()).toHaveLength(4);
            // 摘要已丢
            expect(await (mm as any).treeGet(0, 4)).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('未初始化返回失败结果', async () => {
        const result = await runTool('1');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('越界 ID 返回失败结果而非抛异常', async () => {
        const { mm, dir } = setup();
        try {
            await mm.init();
            await mm.note('a');
            setGlobalMemoryManager(mm);

            const result = await runTool('5');
            expect(result.success).toBe(false);
            expect(result.error).toContain('No memory at index');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
