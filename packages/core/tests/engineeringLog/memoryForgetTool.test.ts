import { memoryEngineFixture } from '../support/memoryEngine';
import { createEngineeringLogTool } from '../../../../backend/tools/memory/engineeringLog';

let memory: Awaited<ReturnType<typeof memoryEngineFixture>>;
/**
 * memory_forget 工具回归测试（三种模式）：
 * 1. 单个数字 ID（如 "5"）：只删除这一条原始记忆，其余保留、id 前移重编号
 * 2. 闭区间（如 "1,3"）：删除 ID 1 到 3 的所有原始记忆
 * 3. 块 ID（如 "0-3"）：只丢弃树摘要，原始记忆不被触碰
 * 4. 非法参数（未初始化 / 越界）返回失败结果而非抛异常
 */

async function runTool(blockId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const tool = createEngineeringLogTool(memory.host);
    return await tool.handler({ action: 'forget', blockId }) as any;
}

describe('engineering_log forget 操作', () => {
    beforeEach(async () => {
        memory = await memoryEngineFixture();
        memory.setGlobalAvailable(false);
    });
    afterEach(async () => {
        await memory.cleanup();
    });

    test('单 ID：只删除这一条，其余保留并重编号', async () => {
        const mm = memory.engine;
        await mm.init();
        for (const t of ['a', 'b', 'c', 'd']) {
            await mm.note(t);
        }
        memory.setGlobalAvailable(true);

        const result = await runTool('1');
        expect(result.success).toBe(true);
        expect(result.data.removed).toBe(1);
        expect(result.data.message).toContain('#1');

        const entries = await mm.listEntries();
        expect(entries.map(e => e.text)).toEqual(['a', 'c', 'd']);
        expect(entries.map(e => e.id)).toEqual([0, 1, 2]);
    });

    test('闭区间：删除 1 到 3 的所有记忆（含端点）', async () => {
        const mm = memory.engine;
        await mm.init();
        for (const t of ['a', 'b', 'c', 'd', 'e']) {
            await mm.note(t);
        }
        memory.setGlobalAvailable(true);

        const result = await runTool('1,3');
        expect(result.success).toBe(true);
        expect(result.data.removed).toBe(3);

        const entries = await mm.listEntries();
        expect(entries.map(e => e.text)).toEqual(['a', 'e']);
    });

    test('块 ID：只丢弃树摘要，原始记忆不被触碰', async () => {
        const mm = memory.engine;
        await mm.init();
        for (const t of ['m1', 'm2', 'm3', 'm4']) {
            await mm.note(t);
        }
        memory.setGlobalAvailable(true);
        await (mm as any).treePut(0, 4, 'summary of all');

        const result = await runTool('0-3');
        expect(result.success).toBe(true);
        expect(result.data.gone).toBe(1);

        // 原始记忆完好
        expect(await mm.listEntries()).toHaveLength(4);
        // 摘要已丢
        expect(await (mm as any).treeGet(0, 4)).toBeNull();
    });

    test('未初始化返回失败结果', async () => {
        const result = await runTool('1');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    test('越界 ID 返回失败结果而非抛异常', async () => {
        const mm = memory.engine;
        await mm.init();
        await mm.note('a');
        memory.setGlobalAvailable(true);

        const result = await runTool('5');
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid delete range');
    });

    test('非法区间 lo > hi：返回明确失败结果而非误导性错误', async () => {
        const mm = memory.engine;
        await mm.init();
        await mm.note('a');
        await mm.note('b');
        memory.setGlobalAvailable(true);

        const result = await runTool('3,1');
        expect(result.success).toBe(false);
        expect(result.error).toContain('lo(3) > hi(1)');

        // 数据未变
        expect(await mm.listEntries()).toHaveLength(2);
    });

    test('删除成功消息提示后续 id 可能重编号', async () => {
        const mm = memory.engine;
        await mm.init();
        await mm.note('a');
        await mm.note('b');
        memory.setGlobalAvailable(true);

        const result = await runTool('1');
        expect(result.success).toBe(true);
        expect(result.data.message).toContain('Later ids may have changed');
    });
});
