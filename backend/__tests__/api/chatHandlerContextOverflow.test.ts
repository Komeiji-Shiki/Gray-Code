import { ChatHandler } from '../../modules/api';
import { ContextBudgetExceededError } from '../../modules/api/chat/services/ContextTrimService';

function createHandler(): ChatHandler {
    return new ChatHandler(
        {} as any, // configManager
        {} as any, // channelManager
        {} as any, // conversationManager
        {} as any  // toolRegistry
    );
}

describe('ChatHandler ContextBudgetExceededError 友好化', () => {
    test('formatError 把 CONTEXT_OVERFLOW 转成 i18n 消息（含估算参数）', () => {
        const handler = createHandler();
        const formatted = (handler as any).formatError(new ContextBudgetExceededError(1301, 1300));

        expect(formatted).toEqual({
            code: 'CONTEXT_OVERFLOW',
            message: expect.stringContaining('1301')
        });
        expect(formatted.message).toContain('1300');
        expect(formatted.message).toContain('上下文窗口');
    });

    test('非流式 handleChat 传播 ContextBudgetExceededError 时返回结构化错误', async () => {
        const handler = createHandler();
        (handler as any).chatFlowService = {
            handleChat: jest.fn().mockRejectedValue(new ContextBudgetExceededError(1301, 1300))
        };

        const result = await handler.handleChat({
            conversationId: 'conv-overflow-1',
            configId: 'cfg-1',
            message: 'hi'
        } as any);

        expect(result).toMatchObject({
            success: false,
            error: { code: 'CONTEXT_OVERFLOW' }
        });
        expect((result as any).error.message).toContain('1301');
        expect((result as any).error.message).not.toContain('Unable to build');
    });

    test('流式 handleChatStream 传播 ContextBudgetExceededError 时 yield 结构化 error chunk', async () => {
        const handler = createHandler();
        (handler as any).chatFlowService = {
            handleChatStream: async function* () {
                throw new ContextBudgetExceededError(1301, 1300);
            }
        };

        const chunks: any[] = [];
        for await (const chunk of handler.handleChatStream({
            conversationId: 'conv-overflow-2',
            configId: 'cfg-1',
            message: 'hi'
        } as any)) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({
            conversationId: 'conv-overflow-2',
            error: { code: 'CONTEXT_OVERFLOW' }
        });
        expect(chunks[0].error.message).toContain('1301');
        expect(chunks[0].error.message).not.toContain('Unable to build');
    });

    test('其他未知错误仍走 UNKNOWN_ERROR 兜底，不受影响', () => {
        const handler = createHandler();
        const formatted = (handler as any).formatError(new Error('boom'));

        expect(formatted.code).toBe('UNKNOWN_ERROR');
        expect(formatted.message).toBe('boom');
    });
});
