/**
 * SubAgent executor 缓存域与用量归集单元测试
 *
 * 覆盖：
 * - 任务1：continueFromRunId 续跑时，generateRequest.conversationId 直接沿用旧 run 的 runId
 *   （user_id 哈希输入与旧 run 一致，provider 侧缓存域天然相同）；普通新 run 仍用新 runId。
 * - 任务2：每轮 generate 返回 usageMetadata 后，把 source='subagent' 的用量条目
 *   归集到主会话用量索引（context.usageIndexAppend）；无主会话归属时跳过。
 */

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents/types';
import type { GenerateResponse } from '../../modules/channel/types';
import type { UsageIndexMessage } from '../../modules/conversation/usageStats';

function createConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
        type: 'tester',
        name: 'Tester',
        description: 'test agent',
        systemPrompt: 'you are a test agent',
        channel: { channelId: 'channel_1' },
        tools: { mode: 'all' },
        maxIterations: 5, // 允许至少一轮 LLM 调用
        maxRuntime: 300,
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

/** 构造一个非流式成功响应（无工具调用），可携带 usageMetadata */
function textResponse(overrides: Partial<GenerateResponse['content']> = {}): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ text: 'done' }],
            modelVersion: 'model-x',
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 50,
                thoughtsTokenCount: 10,
                cacheCreationTokenCount: 20,
                cacheReadTokenCount: 30
            },
            ...overrides
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

/** 创建一个已完成（终态）的旧 run 快照 */
function createCompletedRun(runId: string, conversationId?: string): void {
    subAgentRunEventBus.createRun(runId, 'Tester', { agentType: 'tester', prompt: 'old' }, {
        conversationId,
        initialContents: []
    });
    subAgentRunEventBus.emit({ runId, agentName: 'Tester', type: 'run_completed', timestamp: Date.now() });
}

describe('SubAgent executor - 续跑缓存域（任务1）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('cache_new_run');
        subAgentConcurrencyLimiter.release('cache_plain_run');
    });

    it('continueFromRunId 续跑时 conversationId 沿用旧 runId（缓存域天然一致）', async () => {
        createCompletedRun('cache_old_run', 'conv_1');
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            conversationId: 'conv_1',
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'continue',
            runId: 'cache_new_run',
            continueFromRunId: 'cache_old_run',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(true);
        expect(generateMock).toHaveBeenCalledTimes(1);
        const request = generateMock.mock.calls[0][0];
        // 续跑时 conversationId 沿用旧 runId：user_id 哈希输入与旧 run 一致，缓存域天然相同
        expect(request.conversationId).toBe('cache_old_run');
    });

    it('普通新 run 仍用新 runId，行为不变', async () => {
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            conversationId: 'conv_1',
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'plain',
            runId: 'cache_plain_run',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(true);
        const request = generateMock.mock.calls[0][0];
        expect(request.conversationId).toBe('cache_plain_run');
    });
});

describe('SubAgent executor - 用量归集（任务2）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('usage_run');
        subAgentConcurrencyLimiter.release('usage_no_conv_run');
        subAgentConcurrencyLimiter.release('usage_no_usage_run');
    });

    it('generate 返回 usageMetadata 时，以 source=subagent 归集到主会话索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            conversationId: 'conv_1',
            channelManager: { generate: generateMock } as any,
            usageIndexAppend: usageAppendMock
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'do something',
            runId: 'usage_run',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(true);
        expect(usageAppendMock).toHaveBeenCalledTimes(1);
        const [calledConversationId, messages] = usageAppendMock.mock.calls[0];
        expect(calledConversationId).toBe('conv_1');
        expect(messages).toHaveLength(1);
        const entry: UsageIndexMessage = messages[0];
        expect(entry.source).toBe('subagent');
        expect(entry.prompt).toBe(100);
        expect(entry.candidates).toBe(50);
        expect(entry.thoughts).toBe(10);
        expect(entry.cacheCreation).toBe(20);
        expect(entry.cacheRead).toBe(30);
        expect(entry.modelVersion).toBe('model-x');
        expect(typeof entry.timestamp).toBe('number');
    });

    it('无主会话归属（conversationId 为空）时跳过归集，不写索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createConfig(), createContext({
            // 不提供 conversationId
            channelManager: { generate: generateMock } as any,
            usageIndexAppend: usageAppendMock
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'orphan',
            runId: 'usage_no_conv_run'
        });

        expect(result.success).toBe(true);
        // 模型调用正常执行，但归集被跳过
        expect(generateMock).toHaveBeenCalledTimes(1);
        expect(usageAppendMock).not.toHaveBeenCalled();
    });

    it('响应无 usageMetadata 时不写索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse({ usageMetadata: undefined }));
        const executor = createDefaultExecutor(createConfig(), createContext({
            conversationId: 'conv_1',
            channelManager: { generate: generateMock } as any,
            usageIndexAppend: usageAppendMock
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'no usage',
            runId: 'usage_no_usage_run',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(true);
        expect(usageAppendMock).not.toHaveBeenCalled();
    });
});
