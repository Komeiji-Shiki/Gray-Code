/**
 * SubAgents 嵌套（F2：子 agent 开子子 agent）单元测试 —— executor 层
 *
 * 覆盖：
 * - resolveSubAgentAvailableTools 的 excludeToolNames 不再包含 subagents，todo/memory 仍排除
 * - 工具集包含 subagents 时 systemPrompt 追加中文嵌套说明；不包含时不追加
 * - 请求携带 depth/parentRunId 时：runController 记录深度、登记父子关系、
 *   run_created payload 暴露 depth、run 结束后摘除父子关系
 */

import { createDefaultExecutor, resolveSubAgentAvailableTools } from '../../tools/subagents';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { subAgentRunEventBus } from '../../tools/subagents';
import { subAgentRunController } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import type { GenerateResponse } from '../../modules/channel/types';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';

jest.mock('../../modules/channel/ToolDeclarationResolver', () => ({
    ToolDeclarationResolver: jest.fn()
}));


function createContext(overrides: Partial<SubAgentExecutorContext> = {}): SubAgentExecutorContext {
    return {
        channelManager: {
            generate: jest.fn()
        } as any,
        toolRegistry: { getAllDeclarations: () => [] } as any,
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

function textResponse(overrides: Partial<GenerateResponse['content']> = {}): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ text: 'done' }],
            modelVersion: 'model-x',
            ...overrides
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** 让 ToolDeclarationResolver 的 resolve 返回指定工具声明 */
function mockResolveTools(declarations: Array<{ name: string }>): jest.Mock {
    const resolveMock = jest.fn(() => declarations.map(d => ({
        name: d.name,
        description: `desc of ${d.name}`,
        parameters: { type: 'object', properties: {} }
    })));
    (ToolDeclarationResolver as unknown as jest.Mock).mockImplementation(() => ({ resolve: resolveMock }));
    return resolveMock;
}

describe('SubAgents 嵌套 - 可用工具集（executor 层）', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('excludeToolNames 不再包含 subagents，todo/memory 仍被排除', async () => {
        const resolveMock = mockResolveTools([]);
        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext());

        expect(resolveMock).toHaveBeenCalledTimes(1);
        const options = resolveMock.mock.calls[0][0];
        expect(options.excludeToolNames).not.toContain('subagents');
        // 既有排除行为保持不变：todo / memory 工具仍不向子代理开放
        expect(options.excludeToolNames).toEqual(expect.arrayContaining(['todo_write', 'todo_update']));
        expect(options.excludeToolNames).toEqual(expect.arrayContaining(['memory_wake']));
    });

    test('工具集包含 subagents 时 systemPrompt 追加中文嵌套说明', async () => {
        mockResolveTools([{ name: 'subagents' }, { name: 'read_file' }]);
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'do something',
            runId: 'notice_run'
        });

        expect(result.success).toBe(true);
        const request = generateMock.mock.calls[0][0];
        expect(request.dynamicSystemPrompt).toContain(
            '你可以使用 subagents 工具派生子 agent 协助工作，但一般不需要'
        );
        expect(request.dynamicSystemPrompt).toContain(
            '子 agent 的最终结果会汇总到你的输出，并最终返回给主模型'
        );
        // 原始 systemPrompt 保留在前
        expect(request.dynamicSystemPrompt).toContain('you are a test agent');
    });

    test('工具集不包含 subagents 时不追加嵌套说明（白名单只读 agent 不收到提示）', async () => {
        mockResolveTools([{ name: 'read_file' }]);
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'read only',
            runId: 'notice_plain_run'
        });

        expect(result.success).toBe(true);
        const request = generateMock.mock.calls[0][0];
        expect(request.dynamicSystemPrompt).not.toContain('subagents 工具');
    });
});

describe('SubAgents 嵌套 - 深度与父子关系（executor 层）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('nested_child');
        subAgentRunController.unregister('nested_child');
        jest.clearAllMocks();
    });

    test('depth/parentRunId 随请求生效：记录深度、登记父子关系、run_created 暴露 depth、结束后摘除', async () => {
        mockResolveTools([]);
        let resolveGenerate: (v: unknown) => void = () => { };
        const generateMock = jest.fn(() => new Promise(r => { resolveGenerate = r; }));
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const running = executor({
            agentType: 'tester',
            prompt: 'nested task',
            runId: 'nested_child',
            depth: 2,
            parentRunId: 'nested_parent',
            conversationId: 'conv_nested'
        });

        // generate 挂起期间检查 run 上下文：深度已记录、父子关系已登记
        await flushMicrotasks();
        expect(generateMock).toHaveBeenCalledTimes(1);
        expect(subAgentRunController.getDepth('nested_child')).toBe(2);
        expect(subAgentRunController.getChildren('nested_parent')).toContain('nested_child');

        // run_created 元数据携带深度（Monitor 可展示嵌套层级）
        const created = subAgentRunEventBus.getSnapshot('nested_child')?.events
            .find(e => e.type === 'run_created');
        expect(created?.payload).toMatchObject({ depth: 2 });

        resolveGenerate(textResponse());
        const result = await running;

        expect(result.success).toBe(true);
        // run 结束后父子关系摘除（级联清理只在仍有存活子 run 时生效）
        expect(subAgentRunController.getChildren('nested_parent')).not.toContain('nested_child');
    });

    test('depth 缺省按 0 处理（主模型直接派发），不登记父子关系', async () => {
        mockResolveTools([]);
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'plain',
            runId: 'nested_plain'
        });

        expect(result.success).toBe(true);
        expect(subAgentRunController.getDepth('nested_plain')).toBeUndefined();
        expect(subAgentRunController.getChildren('nested_plain')).toEqual([]);
    });
});
