/**
 * H1 协议：流式工具循环 runToolLoop 的 autoSummary chunk 必须携带 removedCount。
 *
 * 覆盖：
 * 1. 总结成功且 removedCount > 0 时，chunk 携带 removedCount / insertIndex（替换后新下标），
 *    前端据此删除 [insertIndex, insertIndex + removedCount) 区间并前移后续消息索引；
 * 2. 后端兼容旧 summarize 结果（removedCount 缺省）时 chunk 回退为 0（前端保持纯插入旧行为）。
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

function createHarness(summarizeResult: Record<string, unknown>) {
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
    // 第一轮触发总结；总结成功后重新评估不再触发
    const contextTrimService = {
        getHistoryWithContextTrimInfo: jest
            .fn()
            .mockResolvedValueOnce({
                history: [turnStartMessage],
                trimStartIndex: 0,
                needsAutoSummarize: true
            })
            .mockResolvedValue({
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
    const summarizeService = {
        getMaxAutoSummarizeAttemptsPerTurn: jest.fn().mockReturnValue(2),
        handleAutoSummarize: jest.fn().mockResolvedValue(summarizeResult)
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
    service.setSummarizeService(summarizeService as never);
    return { service, summarizeService, contextTrimService, conversationManager };
}

const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

describe('H1：流式 autoSummary chunk 携带 removedCount（前端替换协议）', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    it('总结成功且 removedCount > 0：chunk 携带 removedCount 与替换后的 insertIndex', async () => {
        const { service, summarizeService } = createHarness({
            success: true,
            summaryContent: { role: 'user', parts: [{ text: 'summary' }], isSummary: true, index: 3 },
            summarizedMessageCount: 8,
            insertIndex: 3, // 替换完成后总结的新下标（= 原 historyStartIndex）
            removedCount: 5
        });

        const outputs: unknown[] = [];
        for await (const out of service.runToolLoop({
            conversationId: 'c1',
            configId: 'cfg-1',
            config,
            maxIterations: 5
        })) {
            outputs.push(out);
        }

        expect(summarizeService.handleAutoSummarize).toHaveBeenCalledTimes(1);
        const autoSummaryChunk = outputs.find(o => (o as { autoSummary?: boolean })?.autoSummary === true);
        expect(autoSummaryChunk).toBeDefined();
        expect(autoSummaryChunk).toMatchObject({
            conversationId: 'c1',
            autoSummary: true,
            insertIndex: 3,
            removedCount: 5
        });
        expect((autoSummaryChunk as { summaryContent?: Content }).summaryContent).toMatchObject({
            role: 'user',
            isSummary: true
        });
    });

    it('removedCount 缺省（旧版总结结果）：chunk 回退为 0，保持纯插入旧行为', async () => {
        const { service, summarizeService } = createHarness({
            success: true,
            summaryContent: { role: 'user', parts: [{ text: 'summary' }], isSummary: true, index: 0 },
            summarizedMessageCount: 1,
            insertIndex: 0
            // 无 removedCount 字段
        });

        const outputs: unknown[] = [];
        for await (const out of service.runToolLoop({
            conversationId: 'c1',
            configId: 'cfg-1',
            config,
            maxIterations: 5
        })) {
            outputs.push(out);
        }

        const autoSummaryChunk = outputs.find(o => (o as { autoSummary?: boolean })?.autoSummary === true);
        expect(autoSummaryChunk).toBeDefined();
        expect(autoSummaryChunk).toMatchObject({
            conversationId: 'c1',
            autoSummary: true,
            insertIndex: 0,
            removedCount: 0
        });
        expect(summarizeService.handleAutoSummarize).toHaveBeenCalledTimes(1);
    });
});
