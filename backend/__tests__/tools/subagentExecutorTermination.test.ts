/**
 * SubAgent executor 终态收敛单元测试
 *
 * 覆盖：早退路径（超迭代等）必须发出终态事件、返回 runId，并清理超时轮询定时器。
 *
 * 背景：这些路径过去直接 return 裸对象，既不发 run_failed 也不带 runId，
 *       导致 Monitor 里 run 永远停留在 running，主聊天卡片也无法定位运行详情；
 *       同时超时轮询 setInterval 只在父信号 abort 时才清理，正常结束的 run 会泄漏定时器。
 */

import { createDefaultExecutor } from '../../tools/subagents';
import { subAgentRunEventBus } from '../../tools/subagents';
import { subAgentRunController } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';


function createContext(): SubAgentExecutorContext {
    return {
        // maxIterations=0 时循环在第一次判定就退出，永远不会调用 channelManager
        channelManager: {} as any,
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
}

/** 收集某个 run 的所有事件类型 */
function collectEvents(runId: string): { types: string[]; dispose: () => void } {
    const types: string[] = [];
    const dispose = subAgentRunEventBus.subscribe(event => {
        if (event.runId === runId) types.push(event.type);
    });
    return { types, dispose };
}

describe('SubAgent executor 终态收敛', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('run_iterations');
        subAgentConcurrencyLimiter.release('run_timer');
        subAgentConcurrencyLimiter.release('run_cancelled');
        subAgentConcurrencyLimiter.release('run_queue_cancelled');
        subAgentConcurrencyLimiter.release('queue_holder_1');
        subAgentConcurrencyLimiter.release('queue_holder_2');
        subAgentConcurrencyLimiter.release('queue_holder_3');
        subAgentConcurrencyLimiter.release('run_global_runtime');
        subAgentConcurrencyLimiter.release('run_per_agent_runtime');
        subAgentConcurrencyLimiter.release('run_runtime_unlimited');
    });

    test('超出最大迭代次数时发出 run_failed 并返回 runId', async () => {
        const { types, dispose } = collectEvents('run_iterations');
        try {
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext());
            const result = await executor({
                agentType: 'tester',
                prompt: 'do something',
                runId: 'run_iterations'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Exceeded maximum iterations');
            // 主聊天卡片依赖 runId 打开 Monitor
            expect(result.runId).toBe('run_iterations');

            // run 必须进入终态，不能停留在 running
            expect(types).toContain('run_failed');
            expect(subAgentRunEventBus.getSnapshot('run_iterations')!.status).toBe('failed');
        } finally {
            dispose();
        }
    });

    test('排队被取消时经 finalizeRun 收敛终态：发 run_cancelled、快照 cancelled、结果带 runId', async () => {
        const { types, dispose } = collectEvents('run_queue_cancelled');
        try {
            // 占满默认并发容量（3），让 run 进入排队
            await subAgentConcurrencyLimiter.acquire('queue_holder_1', undefined);
            await subAgentConcurrencyLimiter.acquire('queue_holder_2', undefined);
            await subAgentConcurrencyLimiter.acquire('queue_holder_3', undefined);

            const controller = new AbortController();
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext());
            const runPromise = executor(
                { agentType: 'tester', prompt: 'x', runId: 'run_queue_cancelled' },
                controller.signal
            );
            // 等 run 真正进入排队（run_queued 已发出）后再取消
            for (let i = 0; i < 200; i++) {
                if (subAgentConcurrencyLimiter.getQueueLength() > 0) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            controller.abort();
            const result = await runPromise;

            expect(result.success).toBe(false);
            expect(result.cancelled).toBe(true);
            expect(result.runId).toBe('run_queue_cancelled');
            expect(result.error).toContain('cancelled');
            // 终态事件与快照必须收敛，不能停留在 queued/running
            expect(types).toContain('run_queued');
            expect(types).toContain('run_cancelled');
            expect(subAgentRunEventBus.getSnapshot('run_queue_cancelled')!.status).toBe('cancelled');
        } finally {
            dispose();
            subAgentConcurrencyLimiter.release('queue_holder_1');
            subAgentConcurrencyLimiter.release('queue_holder_2');
            subAgentConcurrencyLimiter.release('queue_holder_3');
        }
    });

    test('run 结束后从活跃控制器注销，不再显示控制按钮', async () => {
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext());
        await executor({ agentType: 'tester', prompt: 'x', runId: 'run_cancelled' });

        expect(subAgentRunController.isActive('run_cancelled')).toBe(false);
        expect(subAgentRunController.getActiveRunIds()).not.toContain('run_cancelled');
    });

    test('run 结束后释放并发席位', async () => {
        const before = subAgentConcurrencyLimiter.getRunningCount();
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext());
        await executor({ agentType: 'tester', prompt: 'x', runId: 'run_iterations' });

        expect(subAgentConcurrencyLimiter.getRunningCount()).toBe(before);
        expect(subAgentConcurrencyLimiter.getQueueLength()).toBe(0);
    });

    test('run 结束后清理超时轮询定时器，不留下常驻 interval', async () => {
        jest.useFakeTimers();
        try {
            const timersBefore = jest.getTimerCount();
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0, maxRuntime: 300 }), createContext());
            const result = await executor({
                agentType: 'tester',
                prompt: 'x',
                runId: 'run_timer'
            });

            expect(result.runId).toBe('run_timer');
            // 泄漏的话这里会残留一个 500ms 轮询 interval
            expect(jest.getTimerCount()).toBe(timersBefore);
        } finally {
            jest.useRealTimers();
        }
    });

    /** 无限流式响应：每 1s yield 一个文本 chunk（挂起期间可被超时轮询 abort） */
    function hangingStream(): AsyncGenerator<{ delta: { text: string }[] }> {
        async function* stream() {
            while (true) {
                yield { delta: [{ text: 'tick' }] };
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return stream();
    }

    test('per-agent 未配置 maxRuntime 时继承全局 defaultMaxRuntime（超时生效）', async () => {
        jest.useFakeTimers();
        try {
            // 无限流每 1s 一个 chunk；全局上限 1s → 1000ms 轮询到超时后 abort 并结算
            const generate = jest.fn(() => hangingStream());
            const context: SubAgentExecutorContext = {
                ...createContext(),
                channelManager: { generate } as any,
                settingsManager: { getSubAgentsConfig: () => ({ defaultMaxRuntime: 1 }) } as any
            };
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 100, maxRuntime: undefined }), context);
            const runPromise = executor({ agentType: 'tester', prompt: 'x', runId: 'run_global_runtime' });
            await jest.advanceTimersByTimeAsync(3000);
            const result = await runPromise;

            expect(result.success).toBe(false);
            expect(result.error).toContain('Exceeded maximum runtime (1s)');
        } finally {
            jest.useRealTimers();
        }
    });

    test('per-agent maxRuntime 优先于全局 defaultMaxRuntime', async () => {
        jest.useFakeTimers();
        try {
            const generate = jest.fn(() => hangingStream());
            const context: SubAgentExecutorContext = {
                ...createContext(),
                channelManager: { generate } as any,
                settingsManager: { getSubAgentsConfig: () => ({ defaultMaxRuntime: 1 }) } as any
            };
            // per-agent maxRuntime=3 > 全局 1 → 以 per-agent 为准（3000ms 才超时）
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 100, maxRuntime: 3 }), context);
            const runPromise = executor({ agentType: 'tester', prompt: 'x', runId: 'run_per_agent_runtime' });
            await jest.advanceTimersByTimeAsync(5000);
            const result = await runPromise;

            expect(result.success).toBe(false);
            expect(result.error).toContain('Exceeded maximum runtime (3s)');
        } finally {
            jest.useRealTimers();
        }
    });

    test('全局 defaultMaxRuntime=-1 表示无限制，run 不被超时中止', async () => {
        jest.useFakeTimers();
        try {
            // 有限流：2 个 chunk 后自然结束 → 无工具调用 → 正常完成，全程无超时
            async function* shortStream() {
                yield { delta: [{ text: 'a' }] };
                await new Promise(resolve => setTimeout(resolve, 1000));
                yield { delta: [{ text: 'b' }] };
            }
            const generate = jest.fn(() => shortStream());
            const context: SubAgentExecutorContext = {
                ...createContext(),
                channelManager: { generate } as any,
                settingsManager: { getSubAgentsConfig: () => ({ defaultMaxRuntime: -1 }) } as any
            };
            const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 100, maxRuntime: undefined }), context);
            const runPromise = executor({ agentType: 'tester', prompt: 'x', runId: 'run_runtime_unlimited' });
            await jest.advanceTimersByTimeAsync(5000);
            const result = await runPromise;

            expect(result.success).toBe(true);
            expect(result.error).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });
});
