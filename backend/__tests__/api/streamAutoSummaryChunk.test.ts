/**
 * H1 协议：流式工具循环 runToolLoop 的 autoSummary chunk 必须携带 removedCount。
 *
 * 覆盖：
 * 1. 总结成功且 removedCount > 0 时，chunk 携带 removedCount / insertIndex（替换后新下标），
 *    前端据此删除 [insertIndex, insertIndex + removedCount) 区间并前移后续消息索引；
 * 2. 后端兼容旧 summarize 结果（removedCount 缺省）时 chunk 回退为 0（前端保持纯插入旧行为）。
 */

import { agentMailbox } from '../../core/services/agentMailbox';
import type { Content } from '../../modules/conversation/types';
import { createAutoSummarizeToolLoopHarness } from '../__fixtures__/harnessFixtures';


const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

describe('流式 autoSummary chunk 携带 removedCount（前端替换协议）', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('总结成功且 removedCount > 0：chunk 携带 removedCount 与替换后的 insertIndex', async () => {
        const { service, summarizeService } = createAutoSummarizeToolLoopHarness({
            summarizeResult: {
                success: true,
                summaryContent: { role: 'user', parts: [{ text: 'summary' }], isSummary: true, index: 3 },
                summarizedMessageCount: 8,
                insertIndex: 3, // 替换完成后总结的新下标（= 原 historyStartIndex）
                removedCount: 5
            }
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

    test('removedCount 缺省（旧版总结结果）：chunk 回退为 0，保持纯插入旧行为', async () => {
        const { service, summarizeService } = createAutoSummarizeToolLoopHarness({
            summarizeResult: {
                success: true,
                summaryContent: { role: 'user', parts: [{ text: 'summary' }], isSummary: true, index: 0 },
                summarizedMessageCount: 1,
                insertIndex: 0
                // 无 removedCount 字段
            }
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
