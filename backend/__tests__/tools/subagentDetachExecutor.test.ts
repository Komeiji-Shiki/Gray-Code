/**
 * SubAgent executor 转后台（detach）集成测试。
 *
 * 覆盖：run 执行期间 detachFromParent 后，父 abort 信号不再取消 run——
 * 用户发新消息旧流 abort 时，前台子代理转为后台继续执行直至正常完成。
 * 对照组证明「未 detach 时父 abort 确实取消 run」，防止 mock 未接对导致假绿。
 */

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunController } from '../../tools/subagents/runController';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext, SubAgentRequest } from '../../tools/subagents/types';

function createConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
        type: 'tester',
        name: 'Tester',
        description: 'test agent',
        systemPrompt: 'you are a test agent',
        channel: { channelId: 'channel_1' },
        tools: { mode: 'all' },
        maxIterations: 5,
        maxRuntime: 300,
        ...overrides
    };
}

/** channelManager.generate 挂起直到显式 release（支持多轮，按调用顺序）；监听请求 abortSignal 模拟真实渠道取消 */
function createGatedChannel(): {
    context: SubAgentExecutorContext;
    generateMock: jest.Mock;
    release: (content?: unknown) => void;
} {
    const releases: Array<(content: unknown) => void> = [];
    const generateMock = jest.fn((req: unknown) => new Promise((resolve, reject) => {
        const signal: AbortSignal | undefined = (req as any)?.abortSignal;
        const onAbort = () => reject(Object.assign(new Error('aborted'), { type: 'CANCELLED_ERROR' }));
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        releases.push((content: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(content);
        });
    }));
    const context: SubAgentExecutorContext = {
        channelManager: { generate: generateMock } as any,
        toolRegistry: undefined as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'function_call',
                multimodalToolsEnabled: false
            })
        } as any
    };
    return {
        context,
        generateMock,
        release: (content?: unknown) => {
            const fn = releases.shift();
            fn?.(content ?? {
                content: {
                    type: 'text',
                    parts: [{ type: 'text', text: 'done' }]
                },
                toolCalls: []
            });
        }
    };
}

async function waitForActive(runId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (subAgentRunController.isActive(runId)) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`run ${runId} never became active`);
}

async function waitForCall(mock: jest.Mock): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (mock.mock.calls.length > 0) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('channelManager.generate never called');
}

async function waitForCallCount(mock: jest.Mock, count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (mock.mock.calls.length >= count) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`channelManager.generate called ${mock.mock.calls.length} times, expected >= ${count}`);
}

describe('SubAgent executor - 转后台（detach）', () => {
    afterEach(() => {
        subAgentRunController.unregister('run_detach_exec');
        subAgentRunController.unregister('run_detach_ctrl');
        subAgentRunController.unregister('run_detach_tool');
        subAgentRunController.unregister('run_detach_queue');
        subAgentRunController.unregister('run_abort_hanging_tool');
        subAgentConcurrencyLimiter.release('run_detach_exec');
        subAgentConcurrencyLimiter.release('run_detach_ctrl');
        subAgentConcurrencyLimiter.release('run_detach_tool');
        subAgentConcurrencyLimiter.release('run_detach_queue');
        subAgentConcurrencyLimiter.release('run_abort_hanging_tool');
        subAgentConcurrencyLimiter.release('holder');
    });

    it('detach 后父 abort 不再取消 run：run 继续执行至完成', async () => {
        const { context, generateMock, release } = createGatedChannel();
        const executor = createDefaultExecutor(createConfig(), context);
        const parentAbort = new AbortController();
        const request: SubAgentRequest = {
            agentType: 'tester',
            prompt: 'do something',
            runId: 'run_detach_exec'
        };
        const runPromise = executor(request, parentAbort.signal);

        await waitForActive('run_detach_exec');
        await waitForCall(generateMock);

        // 用户发新消息：先 detach 再 abort 旧流（StreamAbortManager.create 的顺序）
        expect(subAgentRunController.detachFromParent('run_detach_exec')).toBe(true);
        parentAbort.abort();

        // 给 abort 事件一个传播机会：detach 成功后 run 不应被取消
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(subAgentRunController.isActive('run_detach_exec')).toBe(true);
        expect(subAgentRunController.getState('run_detach_exec')?.status).toBe('running');

        // 放行 generate，run 应正常完成（而不是 cancelled）
        release();
        const result = await runPromise;
        expect(result.cancelled).not.toBe(true);
        expect(result.success).toBe(true);
        expect(result.response).toContain('done');
    });

    it('对照组：未 detach 时父 abort 取消 run', async () => {
        const { context, generateMock } = createGatedChannel();
        const executor = createDefaultExecutor(createConfig(), context);
        const parentAbort = new AbortController();
        const request: SubAgentRequest = {
            agentType: 'tester',
            prompt: 'do something',
            runId: 'run_detach_ctrl'
        };
        const runPromise = executor(request, parentAbort.signal);

        await waitForActive('run_detach_ctrl');
        await waitForCall(generateMock);

        parentAbort.abort();
        const result = await runPromise;
        // 未 detach 时父 abort 通过组合信号/超时桥传播，run 以失败结束并注销（对照组证明 abort 确实影响 run）
        expect(result.success).toBe(false);
        expect(subAgentRunController.isActive('run_detach_ctrl')).toBe(false);
    });

    it('E1 回归：detach 后 run 在后续迭代（工具调用 + 下一轮 generate）中继续执行，不被旧流 abort 杀死', async () => {
        const { context, generateMock, release } = createGatedChannel();
        // 工具执行走 ToolExecutionService（共享执行路径），mock 成功返回
        (context as any).toolExecutionService = {
            executeFunctionCallsWithResults: async () => ({
                toolResults: [{ result: { success: true, result: 'ok' } }],
                responseParts: [],
                multimodalAttachments: undefined
            }),
            // SEC：executor 现在会先查询确认门（确认需求返回 false = 直接放行）
            toolNeedsConfirmation: () => false
        };
        const executor = createDefaultExecutor(createConfig({ maxIterations: 5, maxRuntime: 30 }), context);
        const parentAbort = new AbortController();
        const request: SubAgentRequest = {
            agentType: 'tester',
            prompt: 'do work',
            runId: 'run_detach_tool'
        };
        const runPromise = executor(request, parentAbort.signal);

        await waitForActive('run_detach_tool');
        await waitForCall(generateMock);
        // 第一轮：模型返回工具调用 → executor 执行工具（mock 成功）→ 进入第二轮迭代
        release({
            content: {
                type: 'text',
                parts: [
                    { type: 'text', text: '' },
                    { type: 'functionCall', functionCall: { id: 't1', name: 'read_file', args: { path: 'a.txt' } } }
                ]
            }
        });
        await waitForCallCount(generateMock, 2);

        // 第二轮 generate 挂起时：detach + 旧流 abort
        expect(subAgentRunController.detachFromParent('run_detach_tool')).toBe(true);
        parentAbort.abort();
        await new Promise(resolve => setTimeout(resolve, 20));

        // 转后台的 run 必须仍活跃（否则说明 E1 裸检查把它杀了）
        expect(subAgentRunController.isActive('run_detach_tool')).toBe(true);
        expect(subAgentRunController.getState('run_detach_tool')?.status).toBe('running');

        release(); // 第二轮终答
        const result = await runPromise;
        expect(result.cancelled).not.toBe(true);
        expect(result.success).toBe(true);
    });

    it('exit 可终止卡在不响应 AbortSignal 的工具，并在有界时间内释放 run', async () => {
        const { context, generateMock, release } = createGatedChannel();
        const executeToolMock = jest.fn(() => new Promise(() => undefined));
        (context as any).toolRegistry = {
            getAllDeclarations: () => [{
                name: 'read_file',
                description: 'read a file',
                parameters: { type: 'object', properties: {} }
            }]
        };
        (context as any).toolExecutionService = {
            executeFunctionCallsWithResults: executeToolMock,
            // SEC：executor 现在会先查询确认门（确认需求返回 false = 直接放行）
            toolNeedsConfirmation: () => false
        };
        const executor = createDefaultExecutor(createConfig({ maxIterations: 5, maxRuntime: 30 }), context);
        const runPromise = executor({
            agentType: 'tester',
            prompt: 'run a hanging tool',
            runId: 'run_abort_hanging_tool'
        });

        await waitForActive('run_abort_hanging_tool');
        await waitForCall(generateMock);
        release({
            content: {
                type: 'text',
                parts: [
                    { type: 'text', text: '' },
                    { type: 'functionCall', functionCall: { id: 'hang-1', name: 'read_file', args: { path: 'a.txt' } } }
                ]
            }
        });
        await waitForCall(executeToolMock);

        const startedAt = Date.now();
        expect(subAgentRunController.exit('run_abort_hanging_tool', 'stop now')).toBe(true);
        const result = await Promise.race([
            runPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SubAgent did not stop')), 2000))
        ]);

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toContain('stop now');
        expect(Date.now() - startedAt).toBeLessThan(1500);
        expect(subAgentRunController.isActive('run_abort_hanging_tool')).toBe(false);
    });

    it('E2 回归：排队期间 detach 后 run 继续执行（席位释放后不因父 abort 而死）', async () => {
        // 占满并发席位，让 run 排队
        await subAgentConcurrencyLimiter.acquire('holder', undefined);
        const { context, generateMock, release } = createGatedChannel();
        const executor = createDefaultExecutor(createConfig({ maxRuntime: 30 }), context);
        const parentAbort = new AbortController();
        const request: SubAgentRequest = {
            agentType: 'tester',
            prompt: 'do work',
            runId: 'run_detach_queue'
        };
        const runPromise = executor(request, parentAbort.signal);

        await waitForActive('run_detach_queue');
        // 排队中 detach + 旧流 abort
        expect(subAgentRunController.detachFromParent('run_detach_queue')).toBe(true);
        parentAbort.abort();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(subAgentRunController.isActive('run_detach_queue')).toBe(true);

        // 释放席位 → run 开始执行（若 E2 未修，启动检查会因父信号已 abort 而杀死 run）
        subAgentConcurrencyLimiter.release('holder');
        await waitForCall(generateMock);
        expect(subAgentRunController.isActive('run_detach_queue')).toBe(true);

        release();
        const result = await runPromise;
        expect(subAgentRunController.isActive('run_detach_ctrl')).toBe(false);
    });
});
