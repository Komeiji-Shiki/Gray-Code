import { deleteConversation } from '../../../webview/handlers/ConversationHandlers';
import { deleteMessage, deleteSingleMessage } from '../../../webview/handlers/ChatHandlers';

function createContext(order: string[]): any {
    return {
        streamAbortControllers: {
            async abortAndWaitForCompletion() {
                order.push('abort:start');
                await Promise.resolve();
                order.push('abort:done');
            }
        },
        checkpointManager: {
            async deleteAllCheckpoints() { order.push('checkpoints'); return { success: true, deletedCount: 0 }; }
        },
        conversationManager: {
            async deleteConversation() { order.push('conversation'); },
            async deleteMessage() { order.push('single-message'); },
            async getMessage() {
                order.push('precheck');
                return { id: 'background-receipt-id', role: 'user', parts: [{ text: 'receipt' }] };
            }
        },
        chatHandler: {
            async handleDeleteToMessage() { order.push('message-range'); return { success: true }; },
            async refreshDerivedMetadataAfterHistoryMutation() { order.push('derived'); }
        },
        sendResponse: () => order.push('response'),
        sendError: (_id: string, code: string) => { throw new Error(code); }
    };
}

describe('delete handlers wait for stream completion', () => {
    test('deletes checkpoints/conversation only after the main stream has fully exited', async () => {
        const order: string[] = [];
        await deleteConversation({ conversationId: 'conv_delete_order' }, 'req', createContext(order));
        expect(order).toEqual(['abort:start', 'abort:done', 'checkpoints', 'conversation', 'response']);
    });

    test('range deletion waits for the stream before mutating history', async () => {
        const order: string[] = [];
        await deleteMessage({ conversationId: 'conv_delete_range', targetIndex: 1 }, 'req', createContext(order));
        expect(order).toEqual(['abort:start', 'abort:done', 'message-range', 'response']);
    });

    test('stale messageId is rejected before cancelling the active stream', async () => {
        const order: string[] = [];
        const ctx = createContext(order);
        ctx.conversationManager.getMessage = jest.fn(async () => {
            order.push('precheck');
            return { id: 'new-message-id', role: 'user', parts: [{ text: 'new' }] };
        });
        ctx.chatHandler.handleDeleteToMessage = jest.fn(async () => ({ success: true }));

        await deleteMessage({
            conversationId: 'conv_delete_stale',
            targetIndex: 3,
            messageId: 'old-message-id',
        }, 'req', ctx);

        expect(ctx.chatHandler.handleDeleteToMessage).not.toHaveBeenCalled();
        expect(order).toEqual(['precheck', 'response']);
    });

    test('range deletion forwards messageId so a completed sub-agent receipt cannot be deleted by a stale index', async () => {
        const order: string[] = [];
        const ctx = createContext(order);
        ctx.chatHandler.handleDeleteToMessage = jest.fn(async () => {
            order.push('message-range');
            return { success: true };
        });

        await deleteMessage({
            conversationId: 'conv_delete_subagent_receipt',
            targetIndex: 3,
            messageId: 'background-receipt-id',
        }, 'req', ctx);

        expect(ctx.chatHandler.handleDeleteToMessage).toHaveBeenCalledWith({
            conversationId: 'conv_delete_subagent_receipt',
            targetIndex: 3,
            messageId: 'background-receipt-id',
            preserveCheckpointId: undefined,
        });
        expect(order).toEqual(['precheck', 'abort:start', 'abort:done', 'message-range', 'response']);
    });

    test('single-message deletion uses the same lifecycle barrier', async () => {
        const order: string[] = [];
        await deleteSingleMessage({ conversationId: 'conv_delete_single', targetIndex: 1 }, 'req', createContext(order));
        expect(order).toEqual(['abort:start', 'abort:done', 'single-message', 'derived', 'response']);
    });
});
