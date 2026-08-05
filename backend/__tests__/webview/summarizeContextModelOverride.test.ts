/**
 * summarizeContext 处理器 modelOverride 透传回归测试
 *
 * 背景：前端 summarizeContext 载荷携带 modelOverride（当前对话实际选中的模型），
 * 但 webview 处理器此前只转发 conversationId / configId / abortSignal，
 * 导致手动总结请求仍向 OpenAI 兼容接口发送空模型名
 * （HTTP 404: No available providers at the moment）。
 * 该测试锁住处理器层透传行为，防止回归。
 */

import { summarizeContext } from '../../../webview/handlers/FileHandlers';
import type { HandlerContext } from '../../../webview/types';

function createHandlerContext() {
    const handleSummarizeContext = jest.fn().mockResolvedValue({ success: true });
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    const deleteSummary = jest.fn();
    const ctx: HandlerContext = {
        chatHandler: {
            handleSummarizeContext
        } as any,
        streamAbortControllers: {
            createSummary: jest.fn(() => ({ signal: new AbortController().signal, aborted: false })),
            deleteSummary
        },
        sendResponse,
        sendError
    } as any;

    return { ctx, handleSummarizeContext };
}

describe('summarizeContext handler - modelOverride 透传', () => {
    it('透传前端选择的当前对话模型给后端', async () => {
        const { ctx, handleSummarizeContext } = createHandlerContext();

        await summarizeContext(
            { conversationId: 'conv-1', configId: 'cfg-1', modelOverride: 'deepseek-v4-flash' },
            'req-1',
            ctx
        );

        expect(handleSummarizeContext).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: 'conv-1',
            configId: 'cfg-1',
            modelOverride: 'deepseek-v4-flash'
        }));
    });

    it('未显式选择模型时不携带 modelOverride（后端回落渠道默认模型）', async () => {
        const { ctx, handleSummarizeContext } = createHandlerContext();

        await summarizeContext(
            { conversationId: 'conv-1', configId: 'cfg-1' },
            'req-1',
            ctx
        );

        const request = handleSummarizeContext.mock.calls[0][0];
        expect(request.conversationId).toBe('conv-1');
        expect(request.configId).toBe('cfg-1');
        expect(request.modelOverride).toBeUndefined();
    });

    it('成功结果经 sendResponse 回传前端', async () => {
        const { ctx } = createHandlerContext();

        await summarizeContext(
            { conversationId: 'conv-1', configId: 'cfg-1', modelOverride: 'deepseek-v4-flash' },
            'req-1',
            ctx
        );

        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });
});
