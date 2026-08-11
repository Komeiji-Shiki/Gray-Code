/**
 * SubAgent 文件写锁冲突测试（P4）
 *
 * 覆盖：子代理写工具与主会话/其他子代理共用同一把全局文件写锁；
 *      冲突时返回带 lockConflict 标志与明确持有者信息的失败结果（LLM 可见）；
 *      同一 run（holder.id）并发重入不冲突、不死锁；
 *      未传 attribution 时默认以主会话身份加锁。
 *
 * 说明：使用 update_plan（写类工具但不参与 outside-workspace 检查）作为目标工具，
 *      避免测试环境无工作区上下文时被路径策略过滤拦截。
 *      锁只在工具 handler 执行期间持有，因此用可控 gate 的 handler 模拟“正在写文件”。
 */

import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { fileWriteLockManager, type LockHolder } from '../../core/fileWriteLockManager';

const holderA: LockHolder = { kind: 'subagent', id: 'run_a', label: 'Agent A' };
const holderB: LockHolder = { kind: 'subagent', id: 'run_b', label: 'Agent B' };

function makeCall(id: string, path: string) {
    return { id, name: 'update_plan', args: { path, content: 'x' } };
}

function makeTool(handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    return {
        declaration: {
            name: 'update_plan',
            description: 'update a plan document',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' }
                },
                required: ['path']
            }
        },
        handler
    };
}

/** 可控 gate handler：进入后挂起，直到 release() 才返回 */
function createControllableTool() {
    let releaseHandler: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseHandler = resolve; });
    const handler = async () => {
        await gate;
        return { success: true, data: { applied: true } };
    };
    return { tool: makeTool(handler), release: () => releaseHandler?.() };
}

describe('SubAgent 写工具文件锁（P4）', () => {
    afterEach(() => {
        fileWriteLockManager.releaseAllByHolder(holderA);
        fileWriteLockManager.releaseAllByHolder(holderB);
        fileWriteLockManager.releaseAllByHolder({ kind: 'main', id: 'conv_1', label: 'main' });
    });

    test('子代理写工具与主会话/其他子代理共用同一把锁，冲突返回明确信息', async () => {
        // Agent A 先占用 src/a.md（模拟其写工具正在执行）
        fileWriteLockManager.tryAcquire(['src/a.md'], holderA);

        const service = new ToolExecutionService({ getTool: () => makeTool(async () => ({ success: true })) } as any, undefined, undefined);

        // Agent B 写同一文件 → 非阻塞失败，带 lockConflict 标志
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_b', 'src/a.md')],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            holderB
        );

        const toolResult = result.toolResults[0].result as Record<string, unknown>;
        expect(toolResult.success).toBe(false);
        expect(toolResult.lockConflict).toBe(true);
        const error = String(toolResult.error);
        // 明确告知持有者是哪个 agent，并给出重试协作指引
        expect(error).toContain('File write conflict');
        expect(error).toContain('src/a.md');
        expect(error).toContain('agent "Agent A"');
        expect(error).toContain('retry after the current holder finishes');
        expect(error).toContain('main session can coordinate');

        // 冲突信息同样进入 functionResponse parts（子代理模型能看到）
        expect(result.responseParts.length).toBeGreaterThan(0);
        const responsePart = result.responseParts[0] as any;
        expect(responsePart.functionResponse?.response?.lockConflict).toBe(true);
    });

    test('同一子代理 run 并发重入同一文件不冲突（同 holder 可重入，无死锁）', async () => {
        const { tool, release } = createControllableTool();
        const service = new ToolExecutionService({ getTool: () => tool } as any, undefined, undefined);

        // 同 run 的两个写调用同时在飞：同 holder 重入，均不会被锁挡住
        const first = service.executeFunctionCallsWithResults(
            [makeCall('call_a1', 'src/a.md')],
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            holderA
        );
        const second = service.executeFunctionCallsWithResults(
            [makeCall('call_a2', 'src/a.md')],
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            holderA
        );

        // 其他 run 在持有期间被阻塞
        const blocked = await service.executeFunctionCallsWithResults(
            [makeCall('call_b', 'src/a.md')],
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            holderB
        );
        expect((blocked.toolResults[0].result as Record<string, unknown>).lockConflict).toBe(true);

        // 释放 gate 后同 run 的两个调用都成功（未死锁）
        release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.toolResults[0].result.success).toBe(true);
        expect(secondResult.toolResults[0].result.success).toBe(true);
    });

    test('未传 attribution 时默认以主会话身份加锁', async () => {
        const { tool, release } = createControllableTool();
        const service = new ToolExecutionService({ getTool: () => tool } as any, undefined, undefined);

        // 主会话写调用在飞（conversationId=conv_1 → 默认 main holder）
        const mainCall = service.executeFunctionCallsWithResults(
            [makeCall('call_main', 'src/main.md')],
            'conv_1', undefined, undefined, undefined, undefined, undefined, undefined,
            undefined
        );

        // 其他子代理被主会话的锁挡住
        const blocked = await service.executeFunctionCallsWithResults(
            [makeCall('call_b', 'src/main.md')],
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            holderB
        );
        expect((blocked.toolResults[0].result as Record<string, unknown>).lockConflict).toBe(true);

        release();
        const mainResult = await mainCall;
        expect(mainResult.toolResults[0].result.success).toBe(true);
    });
});
