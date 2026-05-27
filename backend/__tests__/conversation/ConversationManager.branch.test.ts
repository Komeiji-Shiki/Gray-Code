import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory, ConversationMetadata } from '../../modules/conversation/types';

describe('ConversationManager createBranchConversation', () => {
    test('copies history through target message and only carries stable metadata', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const sourceConversationId = 'source-conversation';
        const targetConversationId = 'branch-conversation';

        const sourceHistory: ConversationHistory = [
            { role: 'user', parts: [{ text: 'first user message' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'assistant answer' }], timestamp: 200 },
            { role: 'user', parts: [{ text: 'branch prompt' }], timestamp: 300 },
            { role: 'model', parts: [{ text: 'should not be copied' }], timestamp: 400 }
        ];
        const sourceMetadata: ConversationMetadata = {
            id: sourceConversationId,
            title: 'Source Chat',
            createdAt: 1,
            updatedAt: 2,
            workspaceUri: 'file:///source-workspace',
            custom: {
                inputModelConfig: { channelId: 'gemini', modelId: 'gemini-2.5-pro' },
                promptModeConfig: { modeId: 'planner' },
                inputPinnedFiles: [{ path: 'README.md' }],
                inputSkills: ['typescript'],
                todoList: [{ id: 'todo-1', content: 'keep me', status: 'pending' }],
                checkpoints: [{ id: 'checkpoint-1' }],
                activeBuild: { id: 'build-1' },
                pendingApprovalGate: { id: 'gate-1' },
                trimState: { folded: true }
            }
        };

        await storage.saveHistory(sourceConversationId, sourceHistory);
        await storage.saveMetadata(sourceMetadata);

        const result = await manager.createBranchConversation(sourceConversationId, 2, {
            conversationId: targetConversationId
        });

        expect(result).toMatchObject({
            conversationId: targetConversationId,
            title: 'Source Chat · Branch @3',
            messageCount: 3,
            preview: 'branch prompt',
            workspaceUri: 'file:///source-workspace'
        });

        await expect(storage.loadHistory(targetConversationId)).resolves.toEqual(sourceHistory.slice(0, 3));

        const branchMetadata = await storage.loadMetadata(targetConversationId);
        expect(branchMetadata).toBeTruthy();
        expect(branchMetadata?.workspaceUri).toBe('file:///source-workspace');
        expect(branchMetadata?.custom).toMatchObject({
            inputModelConfig: { channelId: 'gemini', modelId: 'gemini-2.5-pro' },
            promptModeConfig: { modeId: 'planner' },
            inputPinnedFiles: [{ path: 'README.md' }],
            inputSkills: ['typescript'],
            todoList: [{ id: 'todo-1', content: 'keep me', status: 'pending' }],
            messageCount: 3,
            preview: 'branch prompt',
            branch: {
                sourceConversationId,
                sourceMessageIndex: 2
            }
        });
        expect(branchMetadata?.custom?.checkpoints).toBeUndefined();
        expect(branchMetadata?.custom?.activeBuild).toBeUndefined();
        expect(branchMetadata?.custom?.pendingApprovalGate).toBeUndefined();
        expect(branchMetadata?.custom?.trimState).toBeUndefined();

        const copiedCustom = branchMetadata?.custom as Record<string, any>;
        const sourceCustom = sourceMetadata.custom as Record<string, any>;
        expect(copiedCustom.inputPinnedFiles).not.toBe(sourceCustom.inputPinnedFiles);
        expect(copiedCustom.todoList).not.toBe(sourceCustom.todoList);
    });
});
