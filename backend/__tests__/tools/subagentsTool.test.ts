/**
 * SubAgents 工具后台分支（F1.1）单元测试
 *
 * 覆盖：declaration 暴露 background 参数；后台调用立即返回 stub（background/taskId/runId/agentName）；
 *      TaskManager 注册（type background_subagent + 元数据）与注销载荷（response/steps/runId/error）；
 *      独立取消——父轮 abortSignal 已中止时后台任务仍启动，不被连带取消。
 */

import { getSubAgentsTool } from '../../tools/subagents/subagents';
import { subAgentRegistry } from '../../tools/subagents/registry';
import { createDefaultExecutor, getSubAgentExecutorContext } from '../../tools/subagents/executor';
import { TaskManager } from '../../tools/taskManager';
import type { SubAgentConfig } from '../../tools/subagents/types';

jest.mock('../../tools/subagents/registry', () => ({
    subAgentRegistry: {
        getNames: jest.fn(() => ['Test Agent']),
        getAllConfigs: jest.fn(() => []),
        getByName: jest.fn()
    }
}));

jest.mock('../../tools/subagents/executor', () => ({
    createDefaultExecutor: jest.fn(),
    getSubAgentExecutorContext: jest.fn(() => ({}))
}));

jest.mock('../../core/settingsContext', () => ({
    getGlobalToolRegistry: jest.fn(() => null),
    getGlobalMcpManager: jest.fn(() => null),
    getGlobalConfigManager: jest.fn(() => null),
    getGlobalSettingsManager: jest.fn(() => ({
        getSubAgentsConfig: () => ({ agents: [], maxConcurrentAgents: 3, generalWorkerEnabled: false })
    }))
}));

jest.mock('../../tools/taskManager', () => ({
    TaskManager: {
        generateTaskId: jest.fn(() => 'bgagent_test_1'),
        registerTask: jest.fn(),
        unregisterTask: jest.fn(),
        cancelTask: jest.fn(() => ({ success: true })),
        cancelAllTasks: jest.fn(() => 0),
        getTask: jest.fn(() => undefined),
        hasTask: jest.fn(() => false),
        getTasksByType: jest.fn(() => []),
        getAllTasks: jest.fn(() => []),
        getTaskCount: jest.fn(() => 0),
        onTaskEvent: jest.fn(() => () => { }),
        onTaskEventByType: jest.fn(() => () => { })
    }
}));

const TEST_CONFIG: SubAgentConfig = {
    type: 'tester',
    name: 'Test Agent',
    description: 'test agent',
    systemPrompt: 'you are a test agent',
    channel: { channelId: 'channel_1' },
    tools: { mode: 'all' },
    maxIterations: 10,
    maxRuntime: 300,
    enabled: true
};

/** 等待微任务队列排空（fake executor 的 then/catch 回调） */
function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('SubAgents 工具后台分支', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (subAgentRegistry.getByName as jest.Mock).mockReturnValue({ config: TEST_CONFIG, executor: {} });
        // 声明生成需要非空配置列表，否则 description 走「未配置」短分支
        (subAgentRegistry.getAllConfigs as jest.Mock).mockReturnValue([TEST_CONFIG]);
    });

    it('工具声明暴露 background 参数', () => {
        const decl = getSubAgentsTool().declaration as any;
        expect(decl.parameters.properties.background).toBeDefined();
        expect(decl.parameters.properties.background.type).toBe('boolean');
        expect(decl.description).toContain('background: true');
    });

    it('后台调用立即返回 stub，不等待 executor，并注册 background_subagent 任务', async () => {
        let resolveExecutor: (v: unknown) => void = () => { };
        const fakeExecutor = jest.fn(() => new Promise(r => { resolveExecutor = r; }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        (TaskManager.generateTaskId as jest.Mock).mockReturnValue('bgagent_test_1');

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'do review', background: true },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        // 立即返回结构（不等待 executor settle）
        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({
            background: true,
            taskId: 'bgagent_test_1',
            runId: 'subagent_run_tool_abc',
            agentName: 'Test Agent'
        });
        expect(result.data.note).toContain('Background task completed');

        // 任务注册：type + 元数据（前端 backgroundTaskStore 依赖 conversationId/agentName/runId）
        expect(TaskManager.registerTask).toHaveBeenCalledTimes(1);
        expect(TaskManager.registerTask).toHaveBeenCalledWith(
            'bgagent_test_1',
            'background_subagent',
            expect.any(AbortController),
            expect.objectContaining({
                conversationId: 'conv_1',
                agentName: 'Test Agent',
                runId: 'subagent_run_tool_abc'
            })
        );

        // executor 已启动但未被 await（promise 仍挂起）
        expect(fakeExecutor).toHaveBeenCalledTimes(1);
        expect(TaskManager.unregisterTask).not.toHaveBeenCalled();

        resolveExecutor({ success: true, response: 'ok', steps: 1, runId: 'subagent_run_tool_abc', cancelled: false });
        await flushMicrotasks();
        expect(TaskManager.unregisterTask).toHaveBeenCalledTimes(1);
    });

    it('executor 成功后注销任务并携带完整结果载荷', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: true,
            response: 'final report body',
            steps: 5,
            runId: 'subagent_run_tool_abc',
            cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        await tool.handler(
            { agentName: 'Test Agent', prompt: 'x', background: true },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        );
        await flushMicrotasks();

        expect(TaskManager.unregisterTask).toHaveBeenCalledWith(
            'bgagent_test_1',
            'completed',
            expect.objectContaining({
                runId: 'subagent_run_tool_abc',
                agentName: 'Test Agent',
                response: 'final report body',
                steps: 5
            })
        );
    });

    it('executor 失败时注销为 error 并携带错误信息', async () => {
        const fakeExecutor = jest.fn(() => Promise.reject(new Error('boom')));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        await tool.handler(
            { agentName: 'Test Agent', prompt: 'x', background: true },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        );
        await flushMicrotasks();

        expect(TaskManager.unregisterTask).toHaveBeenCalledWith(
            'bgagent_test_1',
            'error',
            expect.objectContaining({ runId: 'subagent_run_tool_abc', agentName: 'Test Agent', error: 'boom' })
        );
    });

    it('executor 被取消时注销为 cancelled', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: false,
            cancelled: true,
            error: 'User cancelled',
            response: '',
            steps: 2,
            runId: 'subagent_run_tool_abc'
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        await tool.handler(
            { agentName: 'Test Agent', prompt: 'x', background: true },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        );
        await flushMicrotasks();

        expect(TaskManager.unregisterTask).toHaveBeenCalledWith('bgagent_test_1', 'cancelled', expect.any(Object));
    });

    it('父轮 abortSignal 已中止时后台任务仍启动（独立取消，不被连带取消）', async () => {
        const fakeExecutor = jest.fn(() => new Promise(() => { }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        const aborted = new AbortController();
        aborted.abort();

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x', background: true },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: aborted.signal }
        ) as any;

        expect(result.success).toBe(true);
        expect(result.data.background).toBe(true);
        expect(TaskManager.registerTask).toHaveBeenCalledTimes(1);
        expect(fakeExecutor).toHaveBeenCalledTimes(1);
    });

    it('前台模式 + 父 signal 已中止时仍返回 cancelled（回归：不改变现有行为）', async () => {
        const aborted = new AbortController();
        aborted.abort();

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: aborted.signal }
        ) as any;

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(TaskManager.registerTask).not.toHaveBeenCalled();
    });

    it('默认 background 缺省为前台行为（不注册任务、正常 await executor）', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: true,
            response: 'done',
            steps: 1,
            runId: 'subagent_run_tool_abc',
            cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        (getSubAgentExecutorContext as jest.Mock).mockReturnValue({});

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(TaskManager.registerTask).not.toHaveBeenCalled();
        expect(TaskManager.unregisterTask).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.data.background).toBeUndefined();
    });
});
