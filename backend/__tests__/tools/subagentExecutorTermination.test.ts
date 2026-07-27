/**
 * SubAgent executor 终态收敛单元测试
 *
 * 覆盖：早退路径（超迭代等）必须发出终态事件、返回 runId，并清理超时轮询定时器。
 *
 * 背景：这些路径过去直接 return 裸对象，既不发 run_failed 也不带 runId，
 *       导致 Monitor 里 run 永远停留在 running，主聊天卡片也无法定位运行详情；
 *       同时超时轮询 setInterval 只在父信号 abort 时才清理，正常结束的 run 会泄漏定时器。
 */

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { subAgentRunController } from '../../tools/subagents/runController';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents/types';

function createConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
        type: 'tester',
        name: 'Tester',
        description: 'test agent',
        systemPrompt: 'you are a test agent',
        channel: { channelId: 'channel_1' },
        tools: { mode: 'all' },
        maxIterations: 0, // 立即触发「超出最大迭代次数」早退路径
        maxRuntime: 300,
        ...overrides
    };
}

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
    });

    it('超出最大迭代次数时发出 run_failed 并返回 runId', async () => {
        const { types, dispose } = collectEvents('run_iterations');
        try {
            const executor = createDefaultExecutor(createConfig(), createContext());
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

    it('run 结束后从活跃控制器注销，不再显示控制按钮', async () => {
        const executor = createDefaultExecutor(createConfig(), createContext());
        await executor({ agentType: 'tester', prompt: 'x', runId: 'run_cancelled' });

        expect(subAgentRunController.isActive('run_cancelled')).toBe(false);
        expect(subAgentRunController.getActiveRunIds()).not.toContain('run_cancelled');
    });

    it('run 结束后释放并发席位', async () => {
        const before = subAgentConcurrencyLimiter.getRunningCount();
        const executor = createDefaultExecutor(createConfig(), createContext());
        await executor({ agentType: 'tester', prompt: 'x', runId: 'run_iterations' });

        expect(subAgentConcurrencyLimiter.getRunningCount()).toBe(before);
        expect(subAgentConcurrencyLimiter.getQueueLength()).toBe(0);
    });

    it('run 结束后清理超时轮询定时器，不留下常驻 interval', async () => {
        jest.useFakeTimers();
        try {
            const timersBefore = jest.getTimerCount();
            const executor = createDefaultExecutor(createConfig({ maxRuntime: 300 }), createContext());
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
});
