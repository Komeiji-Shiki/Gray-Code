/**
 * M3 + H5：非流式工具循环自动总结的回合级计数与 abort 信号回归测试。
 *
 * 覆盖：
 * 1. 【M3】autoSummarizeAttempts 提升到「真实用户回合」级：同回合续跑（isNewTurn=false）
 *    从会话级记录读取已用次数，不再重新从 0 计数（maxAutoSummarizeAttemptsPerTurn 生效）；
 *    新真实用户回合（isNewTurn=true）清零重新计数；
 * 2. 【H5】非流式路径的 handleAutoSummarize 收到 merged abort 信号（此前未传任何信号）。
 */

import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { agentMailbox } from '../../tools/subagents/agentMailbox';
import type { Content } from '../../modules/conversation/types';

function createPromptManagerMock() {
    const emptyBundle = {
        beforeHistoryMessages: [],
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [],
        dynamicSnapshotAfterHistoryMessages: [],
        messages: [],
        dynamicSnapshotMessages: [],
        text: '',
        dynamicSnapshotText: '',
        historyPlacement: 'legacy' as const
    };
    return {
        getPromptContextBundle: jest.fn().mockReturnValue(emptyBundle),
        refreshAndGetPrompt: jest.fn().mockReturnValue('sys'),
        getSystemPrompt: jest.fn().mockReturnValue('sys')
    };
}

function createHarness(summarizeService: unknown) {
    const turnStartMessage: Content = {
        id: 'u-turn-1',
        role: 'user',
        parts: [{ text: 'question' }],
        isUserInput: true,
    };
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([turnStartMessage]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const toolExecutionService = new ToolExecutionService({} as never);
    const checkpointService = {
        createModelMessageCheckpoint: jest.fn().mockResolvedValue(null),
        createToolExecutionCheckpoint: jest.fn().mockResolvedValue(null)
    };
    const messageBuilderService = { buildHistoryOptions: jest.fn().mockReturnValue({}) };
    const contextTrimService = {
        getHistoryWithContextTrimInfo: jest.fn().mockResolvedValue({
            history: [turnStartMessage],
            trimStartIndex: 0,
            needsAutoSummarize: true
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
        extractFunctionCalls: jest.fn().mockReturnValue([])
    };
    const channelManager = {
        generate: jest.fn().mockResolvedValue({
            content: { role: 'model', parts: [{ text: 'final answer' }] }
        })
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
    if (summarizeService) {
        service.setSummarizeService(summarizeService as never);
    }
    return { service, summarizeService: summarizeService as { handleAutoSummarize: jest.Mock }, contextTrimService };
}

function createSummarizeServiceMock(maxAttempts: number) {
    return {
        getMaxAutoSummarizeAttemptsPerTurn: jest.fn().mockReturnValue(maxAttempts),
        handleAutoSummarize: jest.fn().mockResolvedValue({
            success: true,
            summaryContent: { role: 'model', parts: [{ text: 'summary' }] },
            summarizedMessageCount: 1,
            insertIndex: 0,
        }),
    };
}

const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

describe('M3/H5：非流式循环自动总结的回合级计数与 abort 信号', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    it('M3：同回合续跑（isNewTurn=false）复用已用次数，不重新计数', async () => {
        const summarizeService = createSummarizeServiceMock(2);
        const { service } = createHarness(summarizeService);

        // 新真实用户回合：允许 2 次尝试并消耗殆尽
        const first = await service.runNonStreamLoop('c1', 'cfg-1', config, 10, undefined, undefined, 'single', true);
        expect(first.exceededMaxIterations).toBe(false);
        expect(summarizeService.handleAutoSummarize).toHaveBeenCalledTimes(2);

        // 同回合续跑（工具确认后的继续）：已用次数应跨调用保留 → 不再触发总结
        const second = await service.runNonStreamLoop('c1', 'cfg-1', config, 10, undefined, undefined, 'single', false);
        expect(second.exceededMaxIterations).toBe(false);
        expect(summarizeService.handleAutoSummarize).toHaveBeenCalledTimes(2);

        // 新真实用户回合（回合起始消息变化）：清零重新计数
        const summarizeService2 = createSummarizeServiceMock(2);
        const { service: service2, contextTrimService } = createHarness(summarizeService2);
        contextTrimService.getHistoryWithContextTrimInfo.mockResolvedValue({
            history: [{ id: 'u-turn-2', role: 'user', parts: [{ text: 'q2' }], isUserInput: true }],
            trimStartIndex: 0,
            needsAutoSummarize: true,
        });
        await service2.runNonStreamLoop('c1', 'cfg-1', config, 10, undefined, undefined, 'single', true);
        expect(summarizeService2.handleAutoSummarize).toHaveBeenCalledTimes(2);
    });

    it('H5：handleAutoSummarize 收到 merged abort 信号（主请求取消时信号已中止）', async () => {
        const summarizeService = createSummarizeServiceMock(5);
        const { service } = createHarness(summarizeService);

        const mainController = new AbortController();
        mainController.abort(); // 主请求已取消

        await service.runNonStreamLoop(
            'c1', 'cfg-1', config, 10,
            undefined, undefined, 'single', true,
            mainController.signal,
            undefined,
        );

        // 每次自动总结尝试都必须收到 abort 信号（H5 修复前第三参为 undefined）
        const calls = summarizeService.handleAutoSummarize.mock.calls as Array<
            [string, string, AbortSignal | undefined]
        >;
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call[2]).toBeDefined();
            expect(call[2]!.aborted).toBe(true);
        }
    });

    it('H5：仅取消总结（summarizeAbortSignal）也能中止总结调用，不影响主请求信号', async () => {
        const summarizeService = createSummarizeServiceMock(5);
        const { service } = createHarness(summarizeService);

        const mainController = new AbortController();
        const summaryController = new AbortController();
        summaryController.abort(); // 仅取消总结

        await service.runNonStreamLoop(
            'c1', 'cfg-1', config, 10,
            undefined, undefined, 'single', true,
            mainController.signal,
            summaryController.signal,
        );

        const calls = summarizeService.handleAutoSummarize.mock.calls as Array<
            [string, string, AbortSignal | undefined]
        >;
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call[2]).toBeDefined();
            expect(call[2]!.aborted).toBe(true);
        }
        expect(mainController.signal.aborted).toBe(false);
    });
});
