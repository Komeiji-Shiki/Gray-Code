/**
 * SubAgent executor 转后台（detach）集成测试。
 *
 * 覆盖：run 执行期间 detachFromParent 后，父 abort 信号不再取消 run——
 * 用户发新消息旧流 abort 时，前台子代理转为后台继续执行直至正常完成。
 * 对照组证明「未 detach 时父 abort 确实取消 run」，防止 mock 未接对导致假绿。
 */

import { createDefaultExecutor } from '../../tools/subagents';
import { subAgentRunController } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../core/services/agentMailbox';
import type { SubAgentConfig, SubAgentExecutorContext, SubAgentRequest } from '../../tools/subagents';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';


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
        subAgentRunController.unregister('run_agent_message_boundary');
        agentMailbox.clearAll();
        subAgentConcurrencyLimiter.release('run_detach_exec');
        subAgentConcurrencyLimiter.release('run_detach_ctrl');
        subAgentConcurrencyLimiter.release('run_detach_tool');
        subAgentConcurrencyLimiter.release('run_detach_queue');
        subAgentConcurrencyLimiter.release('run_abort_hanging_tool');
        subAgentConcurrencyLimiter.release('run_agent_message_boundary');
        subAgentConcurrencyLimiter.release('holder');
    });

    test('detach 后父 abort 不再取消 run：run 继续执行至完成', async () => {
        const { context, generateMock, release } = createGatedChannel();
        const executor = createDefaultExecutor(createSubAgentConfig(), context);
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

    test('主模型和其他子代理连续发信：收件子代理逐轮处理，所有 provider 请求保持严格前缀与稳定缓存域', async () => {
        const { context, generateMock, release } = createGatedChannel();
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5 }), context);
        const runPromise = executor({
            agentType: 'tester',
            prompt: 'initial task',
            runId: 'run_agent_message_boundary',
            conversationId: 'conv_messages'
        });

        await waitForCall(generateMock);
        const firstRequest = generateMock.mock.calls[0][0];
        const firstHistory = JSON.parse(JSON.stringify(firstRequest.history));
        agentMailbox.registerRun('conv_messages', 'peer_sender', 'Peer Agent');
        expect(agentMailbox.sendMessage({
            conversationId: 'conv_messages',
            fromRunId: MAIN_SESSION_RUN_ID,
            targetRunId: 'run_agent_message_boundary',
            text: 'message from main'
        }).success).toBe(true);
        expect(agentMailbox.sendMessage({
            conversationId: 'conv_messages',
            fromRunId: 'peer_sender',
            targetRunId: 'run_agent_message_boundary',
            text: 'message from peer'
        }).success).toBe(true);

        // 第一轮原本会以纯文本结束；原子完成边界发现来信后必须继续第二轮。
        release({ content: { type: 'text', parts: [{ type: 'text', text: 'first answer' }] } });
        await waitForCallCount(generateMock, 2);
        const secondRequest = generateMock.mock.calls[1][0];
        const secondHistorySnapshot = JSON.parse(JSON.stringify(secondRequest.history));
        const secondHistory = JSON.stringify(secondHistorySnapshot);
        expect(secondHistory).toContain('message from main');
        expect(secondHistory).toContain('message from peer');
        expect(secondHistory).toContain('[Agent messages received]');
        // 新内容只能追加在尾部；第一轮实际发送字节必须是第二轮的严格前缀。
        expect(secondHistorySnapshot.slice(0, firstHistory.length)).toEqual(firstHistory);
        expect(secondHistorySnapshot.length).toBeGreaterThan(firstHistory.length);
        expect(secondRequest.conversationId).toBe(firstRequest.conversationId);
        expect(secondRequest.dynamicSystemPrompt).toBe(firstRequest.dynamicSystemPrompt);
        expect(secondRequest.toolOverrides).toEqual(firstRequest.toolOverrides);

        // 第二轮生成期间再到一封信，迫使执行器进入第三轮；验证前缀连续稳定。
        expect(agentMailbox.sendMessage({
            conversationId: 'conv_messages',
            fromRunId: 'peer_sender',
            targetRunId: 'run_agent_message_boundary',
            text: 'second boundary follow-up'
        }).success).toBe(true);
        release({ content: { type: 'text', parts: [{ type: 'text', text: 'handled first batch' }] } });
        await waitForCallCount(generateMock, 3);
        const thirdRequest = generateMock.mock.calls[2][0];
        const thirdHistorySnapshot = JSON.parse(JSON.stringify(thirdRequest.history));
        expect(thirdHistorySnapshot.slice(0, secondHistorySnapshot.length)).toEqual(secondHistorySnapshot);
        expect(thirdHistorySnapshot.length).toBeGreaterThan(secondHistorySnapshot.length);
        expect(JSON.stringify(thirdHistorySnapshot)).toContain('second boundary follow-up');
        expect(thirdRequest.conversationId).toBe(firstRequest.conversationId);
        expect(thirdRequest.dynamicSystemPrompt).toBe(firstRequest.dynamicSystemPrompt);
        expect(thirdRequest.toolOverrides).toEqual(firstRequest.toolOverrides);

        release({ content: { type: 'text', parts: [{ type: 'text', text: 'handled all messages' }] } });
        const result = await runPromise;
        expect(result.success).toBe(true);
        expect(result.response).toContain('handled all messages');
        expect(generateMock).toHaveBeenCalledTimes(3);
        expect(agentMailbox.isKnownRun('conv_messages', 'run_agent_message_boundary')).toBe(false);
    });

    test('对照组：未 detach 时父 abort 取消 run', async () => {
        const { context, generateMock } = createGatedChannel();
        const executor = createDefaultExecutor(createSubAgentConfig(), context);
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

    test('E1 回归：detach 后 run 在后续迭代（工具调用 + 下一轮 generate）中继续执行，不被旧流 abort 杀死', async () => {
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
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5, maxRuntime: 30 }), context);
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

    test('exit 可终止卡在不响应 AbortSignal 的工具，并在有界时间内释放 run', async () => {
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
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5, maxRuntime: 30 }), context);
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

    test('E2 回归：排队期间 detach 后 run 继续执行（席位释放后不因父 abort 而死）', async () => {
        // 占满并发席位，让 run 排队
        await subAgentConcurrencyLimiter.acquire('holder', undefined);
        const { context, generateMock, release } = createGatedChannel();
        const executor = createDefaultExecutor(createSubAgentConfig({ maxRuntime: 30 }), context);
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
