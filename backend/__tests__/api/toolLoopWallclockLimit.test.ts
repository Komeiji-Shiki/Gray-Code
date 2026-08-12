/**
 * maxToolLoopWallclockMs（无限制模式墙钟时限）可配置性回归测试。
 *
 * 覆盖：
 * 1. maxIterations = -1 且传入很小的 maxToolLoopWallclockMs → 循环在墙钟超时后立即终止，
 *    返回 guardError.code = TOOL_LOOP_WALLCLOCK_LIMIT（非流式路径）；
 * 2. maxToolLoopWallclockMs = -1（不设墙钟时限）→ 即使 maxIterations = -1，墙钟 guard
 *    也绝不触发（deadline 不参与判断），循环按正常语义推进；
 * 3. 有限迭代模式（maxIterations 为正数）→ 墙钟时限不参与约束（保持既有语义零变化）。
 */

import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import { createPromptManagerMock } from '../__fixtures__/mockFixtures';

const config = { id: 'cfg-1', type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

/** 自包含 harness：generate 恒返回工具调用，工具执行立即成功返回空结果（循环可持续迭代） */
function createWallclockHarness() {
    const turnStartMessage = { id: 'u-turn-1', role: 'user', parts: [{ text: 'question' }], isUserInput: true };
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([turnStartMessage]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
    };
    const messageBuilderService = { buildHistoryOptions: jest.fn().mockReturnValue({}) };
    const contextTrimService = {
        getHistoryWithContextTrimInfo: jest.fn().mockResolvedValue({
            history: [turnStartMessage],
            trimStartIndex: 0,
            needsAutoSummarize: false,
            needsContextFallback: false
        }),
        getHistoryWithGranularFallback: jest.fn().mockResolvedValue({
            history: [turnStartMessage],
            trimStartIndex: 0,
            needsAutoSummarize: false
        })
    };
    const toolCallParserService = {
        convertPromptModeToolCallsToFunctionCalls: jest.fn(),
        ensureFunctionCallIds: jest.fn(),
        // 按内容驱动：内容含 functionCall 时返回调用（循环持续），否则返回空（循环正常结束）
        extractFunctionCalls: jest.fn().mockImplementation((content: any) => {
            const hasCall = Array.isArray(content?.parts) && content.parts.some((p: any) => p.functionCall);
            return hasCall ? [{ id: 'call_1', name: 'stub_tool', args: {} }] : [];
        })
    };
    const channelManager = {
        generate: jest.fn().mockResolvedValue({
            content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }] }
        })
    };
    const toolExecutionService = {
        executeFunctionCallsWithResults: jest.fn().mockResolvedValue({
            responseParts: [],
            toolResults: [],
            multimodalAttachments: undefined
        }),
        toolNeedsConfirmation: jest.fn().mockReturnValue(false),
        drainInboxIntoResults: jest.fn()
    };
    const checkpointService = {
        createModelMessageCheckpoint: jest.fn().mockResolvedValue(null),
        createToolExecutionCheckpoint: jest.fn().mockResolvedValue(null)
    };
    const service = new ToolIterationLoopService(
        channelManager as never,
        conversationManager as never,
        toolCallParserService as never,
        messageBuilderService as never,
        {} as never,
        contextTrimService as never,
        toolExecutionService as never,
        checkpointService as never
    );
    service.setPromptManager(createPromptManagerMock() as never);
    return { service, conversationManager, channelManager, toolExecutionService, toolCallParserService };
}

describe('maxToolLoopWallclockMs（无限制模式墙钟时限）可配置性', () => {
    test('maxIterations=-1 + 小墙钟时限 → TOOL_LOOP_WALLCLOCK_LIMIT 兜底错误', async () => {
        const { service } = createWallclockHarness();

        // maxToolLoopWallclockMs = 1ms：第二轮迭代（工具执行后继续）即超时
        const result = await service.runNonStreamLoop(
            'c1', 'cfg-1', config, -1,
            undefined, undefined, 'single', true,
            undefined, undefined,
            1,
        );

        expect(result.exceededMaxIterations).toBe(true);
        expect(result.guardError?.code).toBe('TOOL_LOOP_WALLCLOCK_LIMIT');
        expect(result.guardError?.message).toContain('分钟');
    });

    test('maxToolLoopWallclockMs=-1（不设墙钟时限）→ 墙钟 guard 不触发，循环正常推进', async () => {
        const { service, channelManager } = createWallclockHarness();

        // 第一轮返回工具调用（循环继续），第二轮返回最终答案（循环正常结束）
        channelManager.generate
            .mockResolvedValueOnce({
                content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }] }
            })
            .mockResolvedValueOnce({
                content: { role: 'model', parts: [{ text: 'final answer' }] }
            });

        // 无墙钟时限：即使 maxIterations = -1，墙钟 guard 也绝不触发
        // （回归：此前 deadline=0 导致 Date.now()>0 恒真，第二轮被误判超时终止）
        const result = await service.runNonStreamLoop(
            'c1', 'cfg-1', config, -1,
            undefined, undefined, 'single', true,
            undefined, undefined,
            -1,
        );

        // 正常完成两轮（工具调用轮 + 最终回答轮），无 guardError
        expect(channelManager.generate).toHaveBeenCalledTimes(2);
        expect(result.exceededMaxIterations).toBe(false);
        expect(result.guardError).toBeUndefined();
        expect(result.content).toBeDefined();
    });

    test('有限迭代模式：墙钟时限不参与约束（既有语义不变）', async () => {
        const { service } = createWallclockHarness();

        // maxIterations=1：第一轮生成后即达到迭代上限返回（即使墙钟时限极小也不触发）
        const result = await service.runNonStreamLoop(
            'c1', 'cfg-1', config, 1,
            undefined, undefined, 'single', true,
            undefined, undefined,
            1,
        );

        expect(result.exceededMaxIterations).toBe(true);
        expect(result.guardError).toBeUndefined();
    });
});
