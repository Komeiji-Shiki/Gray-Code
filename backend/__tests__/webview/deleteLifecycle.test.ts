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
            async deleteMessage() { order.push('single-message'); }
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

    test('single-message deletion uses the same lifecycle barrier', async () => {
        const order: string[] = [];
        await deleteSingleMessage({ conversationId: 'conv_delete_single', targetIndex: 1 }, 'req', createContext(order));
        expect(order).toEqual(['abort:start', 'abort:done', 'single-message', 'derived', 'response']);
    });
});
