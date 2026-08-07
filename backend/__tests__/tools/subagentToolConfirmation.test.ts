/**
 * 子代理危险工具确认门测试（SEC）。
 *
 * 覆盖：用户设置需要确认的工具（delete_file / execute_command 等 toolAutoExec=false）
 * 在子代理内被拒绝执行（子代理没有与用户交互的确认通道，不得绕过主链路确认门）；
 * 自动执行的工具不受影响。
 */

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents/types';
import type { GenerateResponse } from '../../modules/channel/types';
import type { Content } from '../../modules/conversation/types';

jest.mock('../../modules/channel/ToolDeclarationResolver', () => ({
    ToolDeclarationResolver: jest.fn()
}));

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
        enabled: true,
        ...overrides
    };
}

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

/** 模拟 ToolDeclarationResolver 的真实过滤语义，mode='all' 全量放行 */
function mockResolveTools(allTools: string[]): void {
    const resolveMock = jest.fn((options: any) => {
        let tools = allTools.map(name => ({
            name,
            description: `desc of ${name}`,
            parameters: { type: 'object', properties: {} }
        }));
        const exclude = new Set<string>(options.excludeToolNames || []);
        tools = tools.filter(t => !exclude.has(t.name));
        return tools;
    });
    (ToolDeclarationResolver as unknown as jest.Mock).mockImplementation(() => ({ resolve: resolveMock }));
}

function textResponse(): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ text: 'done' }],
            modelVersion: 'model-x'
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

function toolCallResponse(name: string, args: Record<string, unknown>): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ functionCall: { name, args, id: `call_${name}` } }],
            modelVersion: 'model-x'
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

describe('子代理危险工具确认门（SEC）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('sec_confirm_blocked');
        subAgentConcurrencyLimiter.release('sec_confirm_allowed');
        subAgentConcurrencyLimiter.release('sec_confirm_fail_closed');
        subAgentConcurrencyLimiter.release('sec_confirm_this_binding');
        jest.clearAllMocks();
    });

    it('需要确认的工具（toolNeedsConfirmation=true）被拒绝执行：不绕过确认门、不执行工具', async () => {
        mockResolveTools(['read_file', 'delete_file', 'execute_command']);
        const executeMock = jest.fn().mockResolvedValue({
            toolResults: [{ result: { success: true, result: 'ok' } }],
            responseParts: [],
            multimodalAttachments: undefined
        });
        const generateMock = jest.fn()
            .mockResolvedValueOnce(toolCallResponse('delete_file', { path: 'C:/tmp/secret.txt' }))
            .mockResolvedValueOnce(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any,
            toolExecutionService: {
                // 确认门：delete_file 需要用户确认
                toolNeedsConfirmation: jest.fn().mockImplementation((toolName: string) => toolName === 'delete_file' || toolName === 'execute_command'),
                executeFunctionCallsWithResults: executeMock
            } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'delete the file',
            runId: 'sec_confirm_blocked'
        });

        // 工具调用被拒绝（未执行）
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0].tool).toBe('delete_file');
        expect(result.toolCalls![0].success).toBe(false);
        // 拒绝原因以 functionResponse 形式回给子模型（下一轮请求的历史可见；
        // 注意：history 数组按引用被后续迭代继续 push，需在整个历史中查找拒绝响应）
        const secondRequestHistory = generateMock.mock.calls[1][0].history as Content[];
        const refusalPart = secondRequestHistory
            .flatMap(m => m.parts ?? [])
            .find(p => p.functionResponse?.response && 'error' in (p.functionResponse.response as Record<string, unknown>));
        const response = refusalPart?.functionResponse?.response as Record<string, unknown> | undefined;
        expect(String(response?.error)).toContain('requires user confirmation');
        // 底层工具执行器未被调用（没有真正删除任何文件）
        expect(executeMock).not.toHaveBeenCalled();
        // 模型收到拒绝原因后给出终答，run 正常完成
        expect(result.success).toBe(true);
    });

    it('自动执行的工具（toolNeedsConfirmation=false）不受影响，正常执行', async () => {
        mockResolveTools(['read_file', 'delete_file']);
        const executeMock = jest.fn().mockResolvedValue({
            toolResults: [{ result: { success: true, result: 'file content' } }],
            responseParts: [],
            multimodalAttachments: undefined
        });
        const generateMock = jest.fn()
            .mockResolvedValueOnce(toolCallResponse('read_file', { path: 'a.txt' }))
            .mockResolvedValueOnce(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any,
            toolExecutionService: {
                toolNeedsConfirmation: jest.fn().mockReturnValue(false),
                executeFunctionCallsWithResults: executeMock
            } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'read the file',
            runId: 'sec_confirm_allowed'
        });

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(result.toolCalls![0].tool).toBe('read_file');
        expect(result.toolCalls![0].success).toBe(true);
        expect(result.success).toBe(true);
    });


    it('共享执行服务缺少确认门（fail-closed）：工具被拒绝执行，不静默放行', async () => {
        mockResolveTools(['delete_file']);
        const executeMock = jest.fn().mockResolvedValue({
            toolResults: [{ result: { success: true, result: 'ok' } }],
            responseParts: [],
            multimodalAttachments: undefined
        });
        const generateMock = jest.fn()
            .mockResolvedValueOnce(toolCallResponse('delete_file', { path: 'C:/tmp/secret.txt' }))
            .mockResolvedValueOnce(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any,
            toolExecutionService: {
                // 不提供 toolNeedsConfirmation：安全门缺失 → fail-closed 拒绝
                executeFunctionCallsWithResults: executeMock
            } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'delete the file',
            runId: 'sec_confirm_fail_closed'
        });

        expect(result.toolCalls![0].success).toBe(false);
        // 拒绝原因（fail-closed 文案）以 functionResponse 形式回给子模型
        const secondRequestHistory = generateMock.mock.calls[1][0].history as Content[];
        const refusalPart = secondRequestHistory
            .flatMap(m => m.parts ?? [])
            .find(p => p.functionResponse?.response && 'error' in (p.functionResponse.response as Record<string, unknown>));
        const response = refusalPart?.functionResponse?.response as Record<string, unknown> | undefined;
        expect(String(response?.error)).toContain('does not provide a confirmation gate');
        expect(executeMock).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    it('确认门方法依赖 this（真实 ToolExecutionService 形态）：不因解构丢失绑定而 TypeError', async () => {
        // 回归测试：修复前 executor 把 toolNeedsConfirmation 解构为独立函数调用，
        // 方法内部依赖 this（真实实现调用 this.getToolRejectionReason）时抛出
        // "Cannot read properties of undefined (reading 'getToolRejectionReason')"，
        // 子代理执行任何工具都会报错。修复后经实例 bind 调用，行为与主链路一致。
        mockResolveTools(['read_file', 'delete_file']);
        const executeMock = jest.fn().mockResolvedValue({
            toolResults: [{ result: { success: true, result: 'ok' } }],
            responseParts: [],
            multimodalAttachments: undefined
        });
        const generateMock = jest.fn()
            .mockResolvedValueOnce(toolCallResponse('delete_file', { path: 'C:/tmp/secret.txt' }))
            .mockResolvedValueOnce(textResponse());

        // 模拟真实 ToolExecutionService：toolNeedsConfirmation 是实例方法，内部依赖 this
        class FakeToolExecutionService {
            executeFunctionCallsWithResults = executeMock;
            toolNeedsConfirmation(toolName: string): boolean {
                return this.isDangerousTool(toolName);
            }
            private isDangerousTool(toolName: string): boolean {
                return toolName === 'delete_file' || toolName === 'execute_command';
            }
        }

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any,
            toolExecutionService: new FakeToolExecutionService() as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'delete the file',
            runId: 'sec_confirm_this_binding'
        });

        // 不再 TypeError：确认门正常生效，delete_file 被拒绝且未执行
        expect(result.toolCalls![0].success).toBe(false);
        const secondRequestHistory = generateMock.mock.calls[1][0].history as Content[];
        const refusalPart = secondRequestHistory
            .flatMap(m => m.parts ?? [])
            .find(p => p.functionResponse?.response && 'error' in (p.functionResponse.response as Record<string, unknown>));
        const response = refusalPart?.functionResponse?.response as Record<string, unknown> | undefined;
        expect(String(response?.error)).toContain('requires user confirmation');
        expect(executeMock).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
});
