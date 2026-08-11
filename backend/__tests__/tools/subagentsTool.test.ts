/**
 * SubAgents 工具后台分支（F1.1）单元测试
 *
 * 覆盖：declaration 暴露 background 参数；后台调用立即返回 stub（background/taskId/runId/agentName）；
 *      TaskManager 注册（type background_subagent + 元数据）与注销载荷（response/steps/runId/error）；
 *      独立取消——父轮 abortSignal 已中止时后台任务仍启动，不被连带取消。
 */

import { getSubAgentsTool } from '../../tools/subagents';
import { subAgentRegistry } from '../../tools/subagents/registry';
import { subAgentRunEventBus } from '../../tools/subagents';
import { createDefaultExecutor, getSubAgentExecutorContext, getRunAllowedTools } from '../../tools/subagents/executor';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { TaskManager } from '../../tools/taskManager';
import type { SubAgentConfig } from '../../tools/subagents';

jest.mock('../../tools/subagents/registry', () => ({
    subAgentRegistry: {
        getNames: jest.fn(() => ['Test Agent']),
        getAllConfigs: jest.fn(() => []),
        getByName: jest.fn()
    }
}));

jest.mock('../../tools/subagents/executor', () => ({
    // H-1（R4 复查）：agentLacksWriteCapability 使用真实实现（纯函数），
    // 让声明裁剪逻辑在测试中与生产一致；executor 入口仍 mock。
    ...jest.requireActual('../../tools/subagents/executor'),
    createDefaultExecutor: jest.fn(),
    getSubAgentExecutorContext: jest.fn(() => ({})),
    getRunAllowedTools: jest.fn(() => undefined)
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
        (subAgentRegistry.getByName as jest.Mock).mockReturnValue({ config: TEST_CONFIG, executor: undefined });
        // 声明生成需要非空配置列表，否则 description 走「未配置」短分支
        (subAgentRegistry.getAllConfigs as jest.Mock).mockReturnValue([TEST_CONFIG]);
    });

    test('工具声明暴露 background 参数', () => {
        const decl = getSubAgentsTool().declaration as any;
        expect(decl.parameters.properties.background).toBeDefined();
        expect(decl.parameters.properties.background.type).toBe('boolean');
        expect(decl.description).toContain('background: true');
    });

    test('后台调用立即返回 stub，不等待 executor，并注册 background_subagent 任务', async () => {
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

    test('executor 成功后注销任务并携带完整结果载荷（含 toolsUsed）', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: true,
            response: 'final report body',
            steps: 5,
            runId: 'subagent_run_tool_abc',
            cancelled: false,
            toolCalls: [
                { tool: 'read_file', args: { path: 'a.png' }, result: { ok: true }, success: true },
                { tool: 'get_symbols', args: { path: 'a.ts' }, result: {}, success: true }
            ]
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
                steps: 5,
                toolsUsed: ['read_file', 'get_symbols']
            })
        );
    });

    test('executor 失败时注销为 error 并携带错误信息', async () => {
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

    test('executor 被取消时注销为 cancelled', async () => {
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

    test('父轮 abortSignal 已中止时后台任务仍启动（独立取消，不被连带取消）', async () => {
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

    test('前台模式 + 父 signal 已中止时仍返回 cancelled（回归：不改变现有行为）', async () => {
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

    test('前台模式 executor 运行后被取消时返回 cancelled 并携带工具使用信息（MED-1）', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: false,
            cancelled: true,
            error: 'User cancelled',
            response: '部分分析结果',
            steps: 2,
            runId: 'subagent_run_cancel_1',
            toolCalls: [
                { tool: 'read_file', args: { path: 'a.png' }, result: { ok: true }, success: true }
            ]
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        // 取消前已调用工具：toolsUsed 非空，主模型可区分"从未开始"与"运行后被取消"
        expect(result.data.toolsUsed).toEqual(['read_file']);
        expect(result.data.steps).toBe(2);
        expect(result.data.partialResponse).toBe('部分分析结果');
    });

    test('默认 background 缺省为前台行为（不注册任务、正常 await executor）', async () => {
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

    test('前台成功返回时 data 携带 toolsUsed 工具名列表（幻觉检测）', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: true,
            response: 'done',
            steps: 2,
            runId: 'subagent_run_tool_abc',
            cancelled: false,
            toolCalls: [
                { tool: 'read_file', args: { path: 'a.png' }, result: { ok: true }, success: true },
                { tool: 'get_symbols', args: { path: 'a.ts' }, result: {}, success: true }
            ]
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        (getSubAgentExecutorContext as jest.Mock).mockReturnValue({});

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(true);
        // 只列名称，不含参数/结果（防 prompt 膨胀与敏感信息泄漏）
        expect(result.data.toolsUsed).toEqual(['read_file', 'get_symbols']);
        expect(result.data.steps).toBe(2);
    });

    test('前台成功返回且子代理未调用任何工具时 toolsUsed 为空数组', async () => {
        const fakeExecutor = jest.fn(() => Promise.resolve({
            success: true,
            response: '完整分析……',
            steps: 0,
            runId: 'subagent_run_tool_abc',
            cancelled: false,
            toolCalls: []
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        (getSubAgentExecutorContext as jest.Mock).mockReturnValue({});

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(true);
        // toolsUsed 空数组 = 子代理没调用任何工具却输出了内容 → 主模型应警惕幻觉
        expect(result.data.toolsUsed).toEqual([]);
        expect(result.data.steps).toBe(0);
    });

    test('显式注册的自定义 executor 被正式调用路径使用并收到会话上下文（F-08）', async () => {
        const customExecutor = jest.fn(async (request: any) => ({
            success: true,
            response: 'custom result',
            steps: 1,
            runId: 'subagent_run_tool_abc',
            cancelled: false
        }));
        (subAgentRegistry.getByName as jest.Mock).mockReturnValue({ config: TEST_CONFIG, executor: customExecutor });

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_abc', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        // 自定义 executor 真正被调用，默认 executor 不再被创建
        expect(customExecutor).toHaveBeenCalledTimes(1);
        expect(createDefaultExecutor).not.toHaveBeenCalled();
        expect(result.success).toBe(true);

        // 自定义 executor 收到本次调用的动态会话上下文
        const requestArg = customExecutor.mock.calls[0][0];
        expect(requestArg.conversationId).toBe('conv_1');
        expect(requestArg.agentType).toBe('tester');
    });

    test('续跑时沿用旧 run 的 agent 身份（忽略本次传入的 agentName），以旧身份解析配置', async () => {
        // 旧 run 属于静态注册的 'Test Agent'（tester 类型）
        subAgentRunEventBus.createRun('cont_ident_old', 'Test Agent', { agentType: 'tester', prompt: 'old' }, {
            conversationId: 'conv_1',
            initialContents: []
        });
        subAgentRunEventBus.emit({ runId: 'cont_ident_old', agentName: 'Test Agent', type: 'run_completed', timestamp: Date.now() });

        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'cont_ident_old', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            // 本次传入与旧 run 不同的 agentName：必须被忽略，沿用 'Test Agent' 身份
            { agentName: 'Other Agent', prompt: 'continue', continueFromRunId: 'cont_ident_old' },
            { toolId: 'tool_ident', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(true);
        // 身份继承：executor 收到旧 run 的 agentType（tester），而不是 'Other Agent' 的
        const request = fakeExecutor.mock.calls[0][0];
        expect(request.agentType).toBe('tester');
        expect(request.continueFromRunId).toBe('cont_ident_old');
        // 返回给前端展示的 agentName 也是旧身份
        expect(result.data.agentName).toBe('Test Agent');
    });

    test('续跑目标旧 agent 已不存在时拒绝，不派发 executor', async () => {
        // 旧 run 属于一个已被删除的 agent（registry 中查不到）
        subAgentRunEventBus.createRun('cont_ghost_old', 'Ghost Agent', { agentType: 'ghost', prompt: 'old' }, {
            conversationId: 'conv_1'
        });
        subAgentRunEventBus.emit({ runId: 'cont_ghost_old', agentName: 'Ghost Agent', type: 'run_completed', timestamp: Date.now() });
        (subAgentRegistry.getByName as jest.Mock).mockReturnValue(undefined);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'continue', continueFromRunId: 'cont_ghost_old' },
            { toolId: 'tool_ghost', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(false);
        expect(result.error).toContain('Ghost Agent');
        expect(result.error).toContain('not found');
        // 身份解析失败发生在派发之前
        expect(createDefaultExecutor).not.toHaveBeenCalled();
    });

    test('H-1：嵌套派发 General Worker 时，request 携带继承自父 run 的工具限制（inheritedToolFilter）', async () => {
        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'subagent_run_gw', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        // 启用 General Worker，并让父 run 只读（无写/执行工具）
        (getGlobalSettingsManager as jest.Mock).mockReturnValue({
            getSubAgentsConfig: () => ({ agents: [], maxConcurrentAgents: 3, generalWorkerEnabled: true })
        });
        (getRunAllowedTools as jest.Mock).mockReturnValue(new Set(['read_file', 'list_files', 'get_symbols']));

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'General Worker', prompt: 'nested research' },
            {
                toolId: 'tool_gw',
                abortSignal: new AbortController().signal,
                channelConfigId: 'channel_1',
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'parent_run_readonly',
                subagentDepth: 1
            }
        ) as any;

        expect(result.success).toBe(true);
        const request = fakeExecutor.mock.calls[0][0];
        // 父 run 的工具限制随请求传给 executor（子 run 工具 = 子配置 ∩ 父限制）
        expect(request.inheritedToolFilter).toEqual(['read_file', 'list_files', 'get_symbols']);
        // 嵌套深度/父子关系保持既有语义
        expect(request.depth).toBe(2);
        expect(request.parentRunId).toBe('parent_run_readonly');
        expect(request.conversationId).toBe('conv_1');
    });

    test('H-1：主模型直接派发（无 mailboxRunId）时不携带 inheritedToolFilter', async () => {
        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'subagent_run_direct', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);
        (getRunAllowedTools as jest.Mock).mockClear();

        const tool = getSubAgentsTool();
        await tool.handler(
            { agentName: 'Test Agent', prompt: 'x' },
            { toolId: 'tool_direct', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        );

        const request = fakeExecutor.mock.calls[0][0];
        expect(request.inheritedToolFilter).toBeUndefined();
        expect(request.parentRunId).toBeUndefined();
        expect(getRunAllowedTools).not.toHaveBeenCalled();
    });

    test('H-1：blacklist 预设（deep-researcher）在工具声明描述中不暴露 subagents（无法派发嵌套）', () => {
        const blacklistConfig: SubAgentConfig = {
            ...TEST_CONFIG,
            type: 'deep-researcher',
            name: 'Deep Researcher',
            tools: {
                mode: 'blacklist',
                blacklist: ['write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory', 'execute_command']
            }
        };
        (subAgentRegistry.getAllConfigs as jest.Mock).mockReturnValue([blacklistConfig]);

        const decl = getSubAgentsTool().declaration as any;
        const agentDesc = decl.parameters.properties.agentName.description as string;
        expect(agentDesc).toContain('Deep Researcher');
        expect(agentDesc).not.toContain('subagents');
        expect(agentDesc).not.toContain('write_file');
        expect(agentDesc).not.toContain('execute_command');
    });
});
