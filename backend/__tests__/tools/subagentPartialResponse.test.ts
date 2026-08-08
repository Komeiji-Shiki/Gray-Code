/**
 * SubAgent executor 幻觉预生成回归测试
 *
 * 覆盖 bug：xml/json prompt 模式下模型在发起工具调用后继续输出文本——
 * 工具结果尚未返回，工具调用之后的文本没有依据，是幻觉（基于文件名/提示词编造）。
 * 若后续轮次遇到空响应（上游返回空内容/失败），旧逻辑会把这段幻觉文本作为
 * partialResponse 返回给主模型，主模型误以为代理已经完成了分析。
 *
 * 修复：
 * 1. 仅忽略"第一个工具调用 part 之后"的非 thought 文本（幻觉尾巴），不进 history；
 *    工具调用之前的分析/计划文本完整保留（基于用户消息与既有工具结果的有效推理）。
 * 2. lastResponse 只在"本轮没有工具调用（代理即将完成）或已有工具结果后"更新，
 *    且使用剥离尾巴后的文本；首个工具结果前的文本不进最终/partial 响应。
 * 3. 提示词纪律（SUBAGENT_TOOL_DISCIPLINE_NOTICE）从源头约束模型。
 */

/// <reference types="jest" />

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents/types';
import type { GenerateResponse } from '../../modules/channel/types';

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
        ...overrides
    };
}

function createContext(overrides: Partial<SubAgentExecutorContext> = {}): SubAgentExecutorContext {
    return {
        channelManager: {
            generate: jest.fn()
        } as any,
        toolRegistry: {
            getAllDeclarations: () => [],
            getTool: () => undefined
        } as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'xml',
                multimodalToolsEnabled: true
            })
        } as any,
        ...overrides
    };
}

/** 第一轮：幻觉预生成文本 + read_file 工具调用（xml 模式同一轮输出） */
function hallucinationTurnResponse(): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [
                { text: '优秀的！我已经成功读取并分析了这张漫画图片。以下为全部台词：\n1. 角色A：「こんな風に……っ」（日文）\n2. 角色A：「いつもの感じでイジり倒して」（日文）' },
                { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'page-15.png' } } }
            ]
        } as any,
        model: 'model-x'
    };
}

/** 空响应：模拟 ChannelManager 对空内容的检测（HTTP 成功但模型返回空 → 抛 EMPTY_RESPONSE_ERROR） */
function emptyResponseError(): never {
    const err = new Error('模型返回了空内容') as Error & { type?: string };
    err.type = 'EMPTY_RESPONSE_ERROR';
    throw err;
}

/** 本 describe 内所有用例使用的 runId（LOW-18：afterEach 按此清单兜底释放信号量席位） */
const TEST_RUN_IDS = [
    'partial_hallucination',
    'partial_normal_finish',
    'partial_two_tool_turns',
    'strip_tool_turn_text',
    'keep_mid_tool_text',
];

describe('SubAgent executor - 工具调用轮预生成幻觉不进入 partialResponse', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        // LOW-18：executor 在最外层 finally 已释放本 run 的席位（幂等）；
        // 此处对全部已知 runId 再兜底释放一次——用例在 acquire 后、finally 前失败
        // （断言前置失败/异常中断）时补释放，避免信号量占用泄漏影响后续用例。
        // release 幂等且不抛错：未持有（正常释放/从未 acquire）时为安全空操作，无需区分返回值。
        for (const runId of TEST_RUN_IDS) {
            subAgentConcurrencyLimiter.release(runId);
        }
        // 防御性校验：若仍有席位残留（如用例派生了未登记 runId 且未释放），
        // 立即暴露为失败，而不是让泄漏静默污染后续用例。
        expect(subAgentConcurrencyLimiter.getRunningCount()).toBe(0);
    });

    it('第一轮幻觉文本+工具调用、第二轮空响应失败时，partialResponse 不包含第一轮幻觉文本', async () => {
        // 构造：第一轮返回"幻觉文本+工具调用"；第二轮返回空内容（上游抽风）
        const generateMock = jest.fn()
            .mockImplementationOnce(async () => hallucinationTurnResponse())
            // ChannelManager 失败后 executor 还会做两次 run 级兜底重试；
            // 本用例需要模拟重试耗尽，避免 mock 队列耗尽后返回 undefined 被误判成成功。
            .mockImplementation(async () => emptyResponseError());

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const resultPromise = executor({
            agentType: 'tester',
            prompt: '请分析漫画图片 page-15.png',
            runId: 'partial_hallucination'
        });
        // 跳过两次 run 级退避（10s + 30s），测试不应真实等待。
        await jest.advanceTimersByTimeAsync(40_000);
        const result = await resultPromise;

        // 空响应导致本轮失败（与线上复现案例一致：上游返回空响应）
        expect(result.success).toBe(false);
        // 修复点：partialResponse 不得携带第一轮工具调用前的幻觉预生成文本
        expect(result.response).not.toContain('こんな風に');
        expect(result.response).not.toContain('いつもの感じ');
        expect(result.response).not.toContain('我已经成功读取并分析');
        // 第一轮没有"无工具调用的最终回答"，lastResponse 保持初始空值
        expect(result.response).toBe('');
    });

    it('工具调用后的尾巴文本被剥离不进 history；工具调用前的分析文本保留', async () => {
        // 第一轮：分析文本 + read_file 工具调用 + 工具调用后的尾巴文本（无依据，应剥离）
        // 第二轮：真实工具结果返回后，模型输出正确分析（无工具调用）→ 正常完成
        const generateMock = jest.fn()
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [
                        { text: '我先分析一下这张图片的结构。' },
                        { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'page-15.png' } } },
                        { text: '这段台词是：角色A「こんな風に……っ」' }
                    ]
                } as any,
                model: 'model-x'
            }))
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [{ text: '### 页面\n这是基于图片的正确分析内容。' }]
                } as any,
                model: 'model-x'
            }));

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: '请分析漫画图片',
            runId: 'strip_tool_turn_text'
        });

        expect(result.success).toBe(true);
        // 最终回答正确返回
        expect(result.response).toContain('基于图片的正确分析内容');

        // 第二轮请求的 history 中，工具轮 model 消息：
        const secondRequest = generateMock.mock.calls[1][0];
        const modelMsg = secondRequest.history.find((m: any) => m.role === 'model');
        // 工具调用前的分析文本保留（有效推理，不剥离）
        expect(JSON.stringify(modelMsg)).toContain('我先分析一下这张图片的结构。');
        // 工具调用后的尾巴文本被剥离（无工具结果支撑，不进 history）
        expect(JSON.stringify(modelMsg)).not.toContain('こんな風に');
        expect(JSON.stringify(modelMsg)).not.toContain('这段台词是');
        // 工具调用仍被保留（functionCall 存在）
        expect(JSON.stringify(modelMsg)).toContain('read_file');
    });

    it('已有工具结果后的"文本+工具调用"轮不剥离（可能是基于真实结果的中间分析）', async () => {
        // 第一轮：纯工具调用（无文本）→ 执行
        // 第二轮：带文本 + 新工具调用（此时已有工具结果，属于合法中间分析）→ 不剥离
        const generateMock = jest.fn()
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.png' } } }]
                } as any,
                model: 'model-x'
            }))
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [
                        { text: '第一张图分析完成，继续读第二张。' },
                        { functionCall: { id: 'call_2', name: 'read_file', args: { path: 'b.png' } } }
                    ]
                } as any,
                model: 'model-x'
            }))
            // 第三轮：完成
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [{ text: '所有图片分析完成。' }]
                } as any,
                model: 'model-x'
            }));

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: '请分析图片',
            runId: 'keep_mid_tool_text'
        });

        expect(result.success).toBe(true);
        expect(result.response).toContain('所有图片分析完成');
        // 第三轮请求 history 中，第二轮 model 消息仍保留中间文本（未剥离）
        const thirdRequest = generateMock.mock.calls[2][0];
        expect(JSON.stringify(thirdRequest.history)).toContain('第一张图分析完成，继续读第二张。');
    });

    it('正常完成路径不受影响：最终无工具调用轮文本仍作为 response 返回', async () => {
        // 第一轮：工具调用；第二轮：最终回答（无工具调用）→ 正常完成
        const generateMock = jest.fn()
            .mockImplementationOnce(async () => hallucinationTurnResponse())
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [{ text: '### 页面\n这是基于图片的正确分析内容。' }]
                } as any,
                model: 'model-x'
            }));

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: '请分析漫画图片',
            runId: 'partial_normal_finish'
        });

        expect(result.success).toBe(true);
        // 最终回答正常返回
        expect(result.response).toContain('基于图片的正确分析内容');
        // 且不混入第一轮的幻觉预生成
        expect(result.response).not.toContain('こんな風に');
    });

    it('多轮工具调用后失败：保留基于真实工具结果的中间分析，仍排除首个工具结果前的幻觉', async () => {
        const generateMock = jest.fn()
            .mockImplementationOnce(async () => hallucinationTurnResponse())
            .mockImplementationOnce(async () => ({
                content: {
                    role: 'model',
                    parts: [
                        { text: '第二轮的中间文本，也是工具调用前的猜测。' },
                        { functionCall: { id: 'call_2', name: 'list_files', args: {} } }
                    ]
                } as any,
                model: 'model-x'
            }))
            // 第三轮及其两次 run 级重试全部失败，确保走“重试耗尽”终态。
            .mockRejectedValue(new Error('AI call failed: upstream error'));

        const executor = createDefaultExecutor(createConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const resultPromise = executor({
            agentType: 'tester',
            prompt: '请分析漫画图片',
            runId: 'partial_two_tool_turns'
        });
        // 跳过两次 run 级退避（10s + 30s），测试不应真实等待。
        await jest.advanceTimersByTimeAsync(40_000);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        // 首个工具结果之前的幻觉预生成仍不进入响应
        expect(result.response).not.toContain('こんな風に');
        // 已有真实工具结果后的中间分析（基于真实结果，非幻觉）进入响应，不再被丢弃
        expect(result.response).toContain('第二轮的中间文本');
    });
});
