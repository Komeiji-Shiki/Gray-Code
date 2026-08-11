/**
 * SubAgent executor 缓存域与用量归集单元测试
 *
 * 覆盖：
 * - 任务1：continueFromRunId 续跑时，generateRequest.conversationId 直接沿用旧 run 的 runId
 *   （user_id 哈希输入与旧 run 一致，provider 侧缓存域天然相同）；普通新 run 仍用新 runId。
 * - 任务2：每轮 generate 返回 usageMetadata 后，把 source='subagent' 的用量条目
 *   归集到主会话用量索引（context.usageIndexAppend）；无主会话归属时跳过。
 */

import { createDefaultExecutor } from '../../tools/subagents';
import { subAgentRunEventBus } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import type { GenerateResponse } from '../../modules/channel/types';
import type { UsageIndexMessage } from '../../modules/conversation/usageStats';
import type { Content } from '../../modules/conversation/types';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';


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
        subAgentConcurrencyLimiter.release('cache_old_run');
        subAgentConcurrencyLimiter.release('cache_plain_run');
        subAgentConcurrencyLimiter.release('cache_old_multi');
    });

    test('continueFromRunId 续跑时 conversationId 沿用旧 runId（缓存域天然一致）', async () => {
        createCompletedRun('cache_old_run', 'conv_1');
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
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
        // run 复用：续跑沿用旧 runId（run 记录 / transcript / 缓存域三位一体）
        expect(result.runId).toBe('cache_old_run');
    });

    test('普通新 run 仍用新 runId，行为不变', async () => {
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
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

    test('续跑请求 history 严格等于旧 run 最后一次实际发送的 history + 新 user 消息（深比较），且不含 Invocation 卡片', async () => {
        // 旧 run：第 1 轮 generate 返回工具调用，第 2 轮返回纯文本（正常完成）
        const oldRunId = 'cache_old_multi';
        // 发送时立即深拷贝记录（executor 之后会原地 push 后续消息，不能持有引用）
        const oldHistories: Content[][] = [];
        const generateMock = jest.fn()
            .mockImplementationOnce(async (req: any) => {
                oldHistories.push(JSON.parse(JSON.stringify(req.history)));
                return {
                    content: {
                        role: 'model',
                        parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }]
                    } as any,
                    model: 'model-x'
                };
            })
            .mockImplementationOnce(async (req: any) => {
                oldHistories.push(JSON.parse(JSON.stringify(req.history)));
                return textResponse();
            });
        const store = {
            getCustomMetadata: jest.fn(async () => ({})),
            setCustomMetadata: jest.fn(async (_conversationId: string, _key: string, _value: unknown) => {})
        };
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            conversationId: 'conv_1',
            conversationStore: store as any,
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'do something',
            runId: oldRunId,
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(true);
        expect(generateMock).toHaveBeenCalledTimes(2);
        // 旧 run 的请求历史从不包含 # SubAgent Invocation 卡片（卡片只进 Monitor contents）
        for (const sent of oldHistories) {
            expect(JSON.stringify(sent)).not.toContain('SubAgent Invocation');
        }
        // lastSentHistory == 旧 run 最后一次实际发送的 history（深拷贝，非同一引用）
        const oldSnapshot = subAgentRunEventBus.getSnapshot(oldRunId)!;
        expect(oldSnapshot.lastSentHistory).toEqual(oldHistories[1]);
        expect(oldSnapshot.lastSentHistory).not.toBe(oldHistories[1]);
        // 卡片仍保留在 Monitor contents（展示语义不变），lastSentHistory 不含它
        expect(JSON.stringify(oldSnapshot.contents[0])).toContain('SubAgent Invocation');
        // lastSentHistory 随 conversation metadata 持久化
        await new Promise(resolve => setTimeout(resolve, 0));
        const writes = store.setCustomMetadata.mock.calls.map(c => c[2] as Record<string, any>);
        const writtenRecord = writes[writes.length - 1][oldRunId];
        expect(writtenRecord.lastSentHistory).toEqual(oldHistories[1]);
        expect(writtenRecord.lastSentHistory).not.toBe(oldHistories[1]);

        // 续跑：baseContents 优先取 lastSentHistory
        let run2SentHistory: Content[] = [];
        let run2Request: any;
        const continueGenerateMock = jest.fn().mockImplementationOnce(async (req: any) => {
            run2Request = req;
            run2SentHistory = JSON.parse(JSON.stringify(req.history));
            return textResponse();
        });
        const executor2 = createDefaultExecutor(createSubAgentConfig(), createContext({
            conversationId: 'conv_1',
            channelManager: { generate: continueGenerateMock } as any
        }));
        const result2 = await executor2({
            agentType: 'tester',
            prompt: 'continue again',
            runId: 'cache_new_multi',
            continueFromRunId: oldRunId,
            conversationId: 'conv_1'
        });

        expect(result2.success).toBe(true);
        expect(continueGenerateMock).toHaveBeenCalledTimes(1);
        // 深比较：续跑实际发送的 history == 旧 run 最后一次实际发送的 history + 新 user 消息
        expect(run2SentHistory).toEqual([
            ...oldHistories[1],
            { role: 'user', parts: [{ text: 'continue again' }] }
        ]);
        // provider 前缀缓存命中条件：续跑发送历史的前缀与旧 run 最后一次实际发送逐条一致
        expect(run2SentHistory.slice(0, oldHistories[1].length)).toEqual(oldHistories[1]);
        // history[0] 不含 # SubAgent Invocation 卡片（续跑前缀与旧 run 实际发送逐条一致）
        expect(JSON.stringify(run2SentHistory[0])).not.toContain('SubAgent Invocation');
        expect(run2SentHistory[0]).toEqual({ role: 'user', parts: [{ text: 'do something' }] });
        // 缓存域一致：conversationId 沿用旧 runId
        expect(run2Request.conversationId).toBe(oldRunId);
        // run 复用：续跑沿用旧 runId，Monitor 里是同一条记录（事件时间线连续：两次 run_completed + 一次 run_resumed）
        expect(result2.runId).toBe(oldRunId);
        const resumedSnapshot = subAgentRunEventBus.getSnapshot(oldRunId)!;
        expect(resumedSnapshot.events.some(e => e.type === 'run_resumed')).toBe(true);
        expect(resumedSnapshot.events.filter(e => e.type === 'run_completed')).toHaveLength(2);
        // 续跑后的 lastSentHistory 更新为续跑轮实际发送的历史
        expect(resumedSnapshot.lastSentHistory).toEqual(run2SentHistory);
    });
});

describe('SubAgent executor - 用量归集（任务2）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('usage_run');
        subAgentConcurrencyLimiter.release('usage_no_conv_run');
        subAgentConcurrencyLimiter.release('usage_no_usage_run');
    });

    test('generate 返回 usageMetadata 时，以 source=subagent 归集到主会话索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
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

    test('无主会话归属（conversationId 为空）时跳过归集，不写索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
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

    test('响应无 usageMetadata 时不写索引', async () => {
        const usageAppendMock = jest.fn(async (_conversationId: string, _messages: UsageIndexMessage[]) => {});
        const generateMock = jest.fn().mockResolvedValue(textResponse({ usageMetadata: undefined }));
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
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
