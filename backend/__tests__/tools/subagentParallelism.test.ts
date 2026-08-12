/**
 * SubAgent executor 并行化边界测试（agent 04 报告 M4/M5/M10 补测）。
 *
 * 覆盖：
 * - M4：maxConcurrentAgents=1 + parentRunId → 立即拒绝（防排队死锁，而非挂 30 分钟）；
 * - M10：并行工具 in-flight 时 detachFromParent + 父 abort → 所有在飞工具不被旧流取消，
 *       run 继续执行至完成（currentOperationHandles 数组化后逐个解绑）；
 * - M5 兜底已删除：abort 收敛由 executeToolCall 500ms 宽限（waitForAbortableOperation）覆盖，
 *       工具层自身超时保证落定，正常执行恢复裸 Promise.all（回归测试：挂死工具不再被
 *       超时兜底误杀 / abort 后 500ms 宽限收敛不卡死）。
 */
import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunController } from '../../tools/subagents/runController';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext, SubAgentRequest, SubAgentResult } from '../../tools/subagents/types';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';

function createContext(overrides: Partial<SubAgentExecutorContext> = {}): SubAgentExecutorContext {
    return {
        channelManager: { generate: jest.fn().mockResolvedValue(textResponse()) } as any,
        toolRegistry: { getAllDeclarations: () => [], getDeclarationsBy: () => [] } as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'function_call',
                multimodalToolsEnabled: false
            })
        } as any,
        ...overrides
    };
}

function textResponse(): unknown {
    return {
        content: {
            role: 'model',
            parts: [{ type: 'text', text: 'done' }],
            modelVersion: 'model-x'
        },
        toolCalls: [],
        model: 'model-x'
    };
}

/** 挂起直到显式 release 的 channel（按调用顺序）；监听 abortSignal 模拟真实渠道取消 */
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

function toolCallsResponse(...calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): unknown {
    return {
        content: {
            type: 'text',
            parts: [
                { type: 'text', text: '' },
                ...calls.map(c => ({ type: 'functionCall', functionCall: { id: c.id, name: c.name, args: c.args } }))
            ]
        }
    };
}

async function waitForActive(runId: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (subAgentRunController.isActive(runId)) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`run ${runId} never became active`);
}

async function waitForCall(mock: jest.Mock): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (mock.mock.calls.length > 0) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('mock never called');
}

async function waitForCallCount(mock: jest.Mock, count: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (mock.mock.calls.length >= count) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`mock called ${mock.mock.calls.length} times, expected >= ${count}`);
}

function mockToolService(context: SubAgentExecutorContext, executeImpl?: jest.Mock): jest.Mock {
    const executeToolMock = executeImpl ?? jest.fn(async () => ({
        toolResults: [{ result: { success: true, result: 'ok' } }],
        responseParts: [],
        multimodalAttachments: undefined
    }));
    (context as any).toolExecutionService = {
        executeFunctionCallsWithResults: executeToolMock,
        toolNeedsConfirmation: () => false
    };
    (context as any).toolRegistry = {
        getAllDeclarations: () => [{
            name: 'read_file',
            description: 'read a file',
            parameters: { type: 'object', properties: {} }
        }],
        getDeclarationsBy: () => []
    };
    return executeToolMock;
}

describe('SubAgent executor - 并行化边界（M4/M5/M10）', () => {
    afterEach(() => {
        subAgentRunController.unregister('m4_nested');
        subAgentRunController.unregister('m4_parent');
        subAgentRunController.unregister('m10_par');
        subAgentRunController.unregister('m5_no_fallback');
        subAgentRunController.unregister('m5_abort_grace');
        subAgentConcurrencyLimiter.release('m4_nested');
        subAgentConcurrencyLimiter.release('m4_parent');
        subAgentConcurrencyLimiter.release('m10_par');
        subAgentConcurrencyLimiter.release('m5_no_fallback');
        subAgentConcurrencyLimiter.release('m5_abort_grace');
        jest.useRealTimers();
    });

    test('M4：maxConcurrentAgents=1 + parentRunId → 立即拒绝而非排队死锁', async () => {
        const context = createContext({
            settingsManager: {
                getSubAgentsConfig: () => ({ agents: [], maxConcurrentAgents: 1, generalWorkerEnabled: false })
            } as any
        });
        const executor = createDefaultExecutor(createSubAgentConfig(), context);
        // runLoop 排队失败路径返回 finalized（success:false）而非 reject
        const result = await executor({
            agentType: 'tester',
            prompt: 'nested call',
            runId: 'm4_nested',
            parentRunId: 'm4_parent'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('deadlock');
        // 未入队未注册：run 不活跃、父派生列表无残留
        expect(subAgentRunController.isActive('m4_nested')).toBe(false);
    });

    test('对照组：maxConcurrentAgents=1 无 parentRunId 仍可正常执行', async () => {
        const context = createContext({
            settingsManager: {
                getSubAgentsConfig: () => ({ agents: [], maxConcurrentAgents: 1, generalWorkerEnabled: false })
            } as any
        });
        const executor = createDefaultExecutor(createSubAgentConfig(), context);
        const result = await executor({
            agentType: 'tester',
            prompt: 'top level',
            runId: 'm4_parent'
        });
        if (!result.success) {
            console.log(`[M4-ctrl debug] ${JSON.stringify({ error: result.error, cancelled: result.cancelled, steps: result.steps })}`);
        }
        expect(result.success).toBe(true);
    });

    test('M10：并行工具 in-flight 时 detach + 父 abort → 所有在飞工具不被取消，run 完成', async () => {
        const { context, generateMock, release } = createGatedChannel();
        // 两个并行 call 各自的 resolve 收集到数组：共享单变量会被后赋值覆盖，只放行一个
        const releaseTools: Array<() => void> = [];
        const executeToolMock = jest.fn(() => new Promise((resolve) => {
            releaseTools.push(() => resolve({
                toolResults: [{ result: { success: true, result: 'ok' } }],
                responseParts: [],
                multimodalAttachments: undefined
            }));
        }));
        mockToolService(context, executeToolMock);
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5, maxRuntime: 30 }), context);
        const parentAbort = new AbortController();
        const runPromise = executor({
            agentType: 'tester',
            prompt: 'parallel tools',
            runId: 'm10_par'
        }, parentAbort.signal);

        await waitForActive('m10_par');
        await waitForCall(generateMock);
        // 第一轮：模型返回 2 个并行工具调用 → 并行段两个 executeToolCall 同时 in-flight
        release(toolCallsResponse(
            { id: 'p1', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'p2', name: 'read_file', args: { path: 'b.txt' } }
        ));
        // 等待工具并行段启动（两个调用都进入 executeToolCall）
        await waitForCallCount(executeToolMock, 2);

        // 并行 in-flight 时 detach + 旧流 abort（StreamAbortManager.create 顺序）
        expect(subAgentRunController.detachFromParent('m10_par')).toBe(true);
        parentAbort.abort();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(subAgentRunController.isActive('m10_par')).toBe(true);

        // 放行两个工具 → 第二轮 generate → 终答：run 不被取消
        releaseTools.forEach(fn => fn());
        await waitForCallCount(generateMock, 2);
        release();
        const result = await runPromise;
        expect(result.success).toBe(true);
        expect(result.cancelled).not.toBe(true);
        expect(executeToolMock).toHaveBeenCalledTimes(2);
    });

    test('挂死工具不再被超时兜底误杀：无 abort 时推进超过原 30s 窗口 run 仍活跃', async () => {
        jest.useFakeTimers();
        const { context, generateMock, release } = createGatedChannel();
        // 工具永不 settle 且无 abort 触发——M5 兜底删除后不应再有 30s 硬上限误杀正常慢工具
        const executeToolMock = jest.fn(() => new Promise(() => undefined));
        mockToolService(context, executeToolMock);
        // maxRuntime 120s > 推进的 40s，确保只有（已删除的）M5 窗口会触发
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5, maxRuntime: 120 }), context);
        const runPromise = executor({
            agentType: 'tester',
            prompt: 'hanging parallel tools',
            runId: 'm5_no_fallback'
        });

        // fake timers 驱动：run 启动 → 第一轮 generate 完成 → 工具进入并行段挂死
        await jest.advanceTimersByTimeAsync(100);
        release(toolCallsResponse(
            { id: 'h1', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'h2', name: 'read_file', args: { path: 'b.txt' } }
        ));
        await jest.advanceTimersByTimeAsync(100);
        expect(executeToolMock).toHaveBeenCalledTimes(2);

        // 推进超过原 30s 收尾窗口：run 仍应活跃且未 settle（无 abort、无兜底误杀）
        await jest.advanceTimersByTimeAsync(40_000);
        expect(subAgentRunController.isActive('m5_no_fallback')).toBe(true);
        let settled: SubAgentResult | undefined;
        void runPromise.then((r) => { settled = r; });
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBeUndefined();
        // 注意：run 会一直挂着，测试结束靠 afterEach 的 unregister/release 清理，不要 await runPromise
    });

    test('abort 后不响应 abort 的挂死工具在 500ms 宽限后被结算，run 收敛不卡死', async () => {
        jest.useFakeTimers();
        const { context, generateMock, release } = createGatedChannel();
        // 工具永不 settle 且不响应 abort——executeToolCall 的 500ms 宽限（waitForAbortableOperation）
        // 是唯一收敛路径：宽限到期后结算为 cancelled 结果 → Promise.all 收敛 → run 正常收尾
        const executeToolMock = jest.fn(() => new Promise(() => undefined));
        mockToolService(context, executeToolMock);
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5, maxRuntime: 120 }), context);
        const abortCtrl = new AbortController();
        const runPromise = executor({
            agentType: 'tester',
            prompt: 'hanging parallel tools',
            runId: 'm5_abort_grace'
        }, abortCtrl.signal);

        // fake timers 驱动：run 启动 → 第一轮 generate 完成 → 工具进入并行段挂死
        await jest.advanceTimersByTimeAsync(100);
        release(toolCallsResponse(
            { id: 'h1', name: 'read_file', args: { path: 'a.txt' } },
            { id: 'h2', name: 'read_file', args: { path: 'b.txt' } }
        ));
        await jest.advanceTimersByTimeAsync(100);
        expect(executeToolMock).toHaveBeenCalledTimes(2);

        // abort → waitForAbortableOperation 立即返回 aborted → 500ms 宽限到期后工具结算为
        // cancelled → Promise.all 收敛 → 下一轮 loop 顶部 abort 检查 → run 以 cancelled 收尾
        abortCtrl.abort();
        await jest.advanceTimersByTimeAsync(600);
        const result = await runPromise;
        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(subAgentRunController.isActive('m5_abort_grace')).toBe(false);
    });
});
