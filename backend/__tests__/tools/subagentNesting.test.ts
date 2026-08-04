/**
 * SubAgents 嵌套（F2：子 agent 开子子 agent）单元测试 —— handler / runController 层
 *
 * 覆盖：
 * - 子代理工具集描述不再排除 subagents（todo/memory 仍排除）
 * - 深度传递：主模型=0 → 子=1 → 子子=2；request.depth = 父深度 + 1
 * - 超限拒绝：subagentDepth=2（子子）再派发时返回明确错误，executor 不被调用
 * - 嵌套 run 的会话归属：conversationId 回退到 mailboxConversationId（主会话）
 * - runController 父子登记 / 摘除 / 级联退出（级联清理）
 */

import { getSubAgentsTool } from '../../tools/subagents/subagents';
import { subAgentRegistry } from '../../tools/subagents/registry';
import { createDefaultExecutor, getSubAgentExecutorContext } from '../../tools/subagents/executor';
import { SubAgentRunController } from '../../tools/subagents/runController';
import { TaskManager } from '../../tools/taskManager';
import { MAX_SUBAGENT_NESTING_DEPTH } from '../../tools/subagents/types';
import type { SubAgentConfig } from '../../tools/subagents/types';

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
    getGlobalToolRegistry: jest.fn(() => ({
        getToolNames: () => ['read_file', 'subagents', 'todo_write', 'todo_update', 'memory_wake']
    })),
    getGlobalMcpManager: jest.fn(() => null),
    getGlobalConfigManager: jest.fn(() => null),
    getGlobalSettingsManager: jest.fn(() => ({
        getSubAgentsConfig: () => ({ agents: [], maxConcurrentAgents: 3, generalWorkerEnabled: false })
    }))
}));

jest.mock('../../tools/taskManager', () => ({
    TaskManager: {
        generateTaskId: jest.fn(() => 'bgagent_nested_1'),
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

/** 等待微任务队列排空 */
function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('SubAgents 嵌套 - 工具集与深度限制（handler 层）', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (subAgentRegistry.getByName as jest.Mock).mockReturnValue({ config: TEST_CONFIG, executor: undefined });
        (subAgentRegistry.getAllConfigs as jest.Mock).mockReturnValue([TEST_CONFIG]);
    });

    it('子代理工具描述不再排除 subagents，todo/memory 仍排除', () => {
        const decl = getSubAgentsTool().declaration as any;
        const agentDesc = decl.parameters.properties.agentName.description as string;
        // 子代理可用工具列表现在包含 subagents（允许嵌套）
        expect(agentDesc).toContain('subagents');
        // todo / memory 工具仍然不向子代理暴露
        expect(agentDesc).not.toContain('todo_write');
        expect(agentDesc).not.toContain('todo_update');
        expect(agentDesc).not.toContain('memory_wake');
    });

    it('主模型直接派发：depth=1，parentRunId 缺省，conversationId 透传', async () => {
        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'subagent_run_tool_a', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'do review' },
            { toolId: 'tool_a', conversationId: 'conv_1', abortSignal: new AbortController().signal }
        ) as any;

        expect(result.success).toBe(true);
        const request = fakeExecutor.mock.calls[0][0];
        expect(request.depth).toBe(1);            // 主模型=0 → 子=1
        expect(request.parentRunId).toBeUndefined();
        expect(request.conversationId).toBe('conv_1');
    });

    it('子 agent 派发：depth=2（子子），parentRunId=mailboxRunId，conversationId 回退主会话', async () => {
        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'subagent_run_tool_b', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'review the reviewer' },
            {
                toolId: 'tool_b',
                abortSignal: new AbortController().signal,
                // 子代理内部工具调用：conversationId 为 undefined，信箱身份携带主会话与父 runId
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'subagent_run_tool_a',
                subagentDepth: 1
            }
        ) as any;

        expect(result.success).toBe(true);
        const request = fakeExecutor.mock.calls[0][0];
        expect(request.depth).toBe(2);            // 子=1 → 子子=2
        expect(request.parentRunId).toBe('subagent_run_tool_a');
        // 嵌套 run 会话归属回退到信箱主会话 ID
        expect(request.conversationId).toBe('conv_1');
    });

    it('超限拒绝：subagentDepth=2（子子）再派发时返回明确错误，executor 不被调用', async () => {
        const fakeExecutor = jest.fn((..._args: any[]) => undefined);
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'go deeper' },
            {
                toolId: 'tool_c',
                abortSignal: new AbortController().signal,
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'subagent_run_tool_b',
                subagentDepth: 2
            }
        ) as any;

        expect(result.success).toBe(false);
        expect(result.error).toContain('nesting depth limit');
        expect(result.error).toContain(`depth 3`);
        expect(result.error).toContain(`${MAX_SUBAGENT_NESTING_DEPTH}`);
        expect(fakeExecutor).not.toHaveBeenCalled();
        expect(createDefaultExecutor).not.toHaveBeenCalled();
    });

    it('超限拒绝同样拦截后台模式，不注册后台任务', async () => {
        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'go deeper', background: true },
            {
                toolId: 'tool_d',
                abortSignal: new AbortController().signal,
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'subagent_run_tool_b',
                subagentDepth: 2
            }
        ) as any;

        expect(result.success).toBe(false);
        expect(result.error).toContain('nesting depth limit');
        expect(TaskManager.registerTask).not.toHaveBeenCalled();
    });

    it('深度边界：subagentDepth=1 派发 depth=2 合法（不触发拒绝）', async () => {
        const fakeExecutor = jest.fn(async (_request: any) => ({
            success: true, response: 'ok', steps: 1, runId: 'subagent_run_tool_e', cancelled: false
        }));
        (createDefaultExecutor as jest.Mock).mockReturnValue(fakeExecutor);

        const tool = getSubAgentsTool();
        const result = await tool.handler(
            { agentName: 'Test Agent', prompt: 'one more level' },
            {
                toolId: 'tool_e',
                abortSignal: new AbortController().signal,
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'subagent_run_tool_a',
                subagentDepth: 1
            }
        ) as any;

        expect(result.success).toBe(true);
        expect(fakeExecutor).toHaveBeenCalledTimes(1);
        expect(fakeExecutor.mock.calls[0][0].depth).toBe(2);
    });
});

describe('SubAgents 嵌套 - runController 父子登记与级联清理', () => {
    it('registerChild/getChildren/unregisterChild 维护派生关系', () => {
        const controller = new SubAgentRunController();
        controller.register('parent_run', 'Parent', 1);
        controller.registerChild('parent_run', 'child_a');
        controller.registerChild('parent_run', 'child_b');

        expect(controller.getChildren('parent_run').sort()).toEqual(['child_a', 'child_b']);

        controller.unregisterChild('parent_run', 'child_a');
        expect(controller.getChildren('parent_run')).toEqual(['child_b']);

        controller.unregisterChild('parent_run', 'child_b');
        expect(controller.getChildren('parent_run')).toEqual([]);
        // 摘除幂等
        controller.unregisterChild('parent_run', 'child_b');
        expect(controller.getChildren('parent_run')).toEqual([]);
    });

    it('cascadeExitChildren 把全部子 run 置为 cancelled 并携带退出原因，重复调用幂等', () => {
        const controller = new SubAgentRunController();
        controller.register('parent_run', 'Parent', 1);
        controller.register('child_a', 'ChildA', 2);
        controller.register('child_b', 'ChildB', 2);
        controller.registerChild('parent_run', 'child_a');
        controller.registerChild('parent_run', 'child_b');

        const exited = controller.cascadeExitChildren('parent_run', 'parent ended');

        expect(exited.sort()).toEqual(['child_a', 'child_b']);
        expect(controller.getState('child_a')!.status).toBe('cancelled');
        expect(controller.getState('child_b')!.status).toBe('cancelled');
        expect(controller.getExitReason('child_a')).toBe('parent ended');
        // 关系表已清空，再次级联为 no-op
        expect(controller.cascadeExitChildren('parent_run')).toEqual([]);
    });

    it('cascadeExitChildren 对已结束/未注册的子 run 是 no-op（幂等安全）', () => {
        const controller = new SubAgentRunController();
        controller.register('parent_run', 'Parent', 1);
        controller.register('child_a', 'ChildA', 2);
        controller.registerChild('parent_run', 'child_a');
        controller.registerChild('parent_run', 'ghost_child');

        const exited = controller.cascadeExitChildren('parent_run', 'done');
        expect(exited).toContain('child_a');
        expect(exited).toContain('ghost_child');
        // ghost_child 未注册，exit 为 no-op，不影响 child_a
        expect(controller.getState('child_a')!.status).toBe('cancelled');
        expect(controller.getState('ghost_child')).toBeUndefined();
    });

    it('register 携带嵌套深度，getDepth 可读（供 Monitor 元数据）', () => {
        const controller = new SubAgentRunController();
        controller.register('depth_run', 'Agent', 2);
        expect(controller.getDepth('depth_run')).toBe(2);
        controller.register('plain_run', 'Agent');
        expect(controller.getDepth('plain_run')).toBeUndefined();
        expect(controller.getDepth('missing_run')).toBeUndefined();
    });
});
