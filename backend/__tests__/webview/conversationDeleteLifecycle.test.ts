const lifecycle: string[] = [];

jest.mock('../../../backend/tools/subagents/runEventBus', () => ({
    subAgentRunEventBus: {
        getSnapshots: jest.fn(() => [{ runId: 'run-1', conversationId: 'conv-1' }]),
        flushConversation: jest.fn(async () => { lifecycle.push('flush-subagents'); }),
        forgetConversation: jest.fn(() => { lifecycle.push('forget-subagents'); })
    }
}));

jest.mock('../../../backend/tools/subagents/runController', () => ({
    subAgentRunController: {
        isActive: jest.fn(() => true),
        exit: jest.fn(() => { lifecycle.push('exit-subagent'); return true; }),
        waitForInactive: jest.fn(async () => { lifecycle.push('wait-subagents'); })
    }
}));

import { deleteConversation } from '../../../webview/handlers/ConversationHandlers';

function createContext(): any {
    return {
        streamAbortControllers: {
            abortAndWaitForCompletion: jest.fn(async () => { lifecycle.push('stop-main-stream'); })
        },
        checkpointManager: {
            deleteAllCheckpoints: jest.fn(async () => { lifecycle.push('delete-checkpoints'); })
        },
        conversationManager: {
            deleteConversation: jest.fn(async () => { lifecycle.push('delete-conversation'); })
        },
        sendResponse: jest.fn(() => { lifecycle.push('respond'); }),
        sendError: jest.fn()
    };
}

describe('conversation.deleteConversation 生命周期', () => {
    beforeEach(() => lifecycle.splice(0));

    it('先停止并排空主流与子代理，再删除检查点和会话', async () => {
        const ctx = createContext();
        await deleteConversation({ conversationId: 'conv-1' }, 'req-1', ctx);

        expect(lifecycle).toEqual([
            'stop-main-stream',
            'exit-subagent',
            'wait-subagents',
            'flush-subagents',
            'delete-checkpoints',
            'delete-conversation',
            'forget-subagents',
            'respond'
        ]);
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });

    it('拒绝空会话 ID，且不执行删除', async () => {
        const ctx = createContext();
        await deleteConversation({ conversationId: '  ' }, 'req-2', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req-2', 'DELETE_CONVERSATION_INVALID_ID', 'Invalid conversation ID');
        expect(lifecycle).toEqual([]);
    });
});
