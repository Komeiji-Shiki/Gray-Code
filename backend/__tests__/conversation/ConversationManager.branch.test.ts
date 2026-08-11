import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { ConversationHistory, ConversationMetadata, ContentPart } from '../../modules/conversation';

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

        // BR-01/BR-02：分支复制会先迁移源历史，复制内容带稳定 id + 线性 parentId；
        // 其余字段与源历史完全一致（只复制到目标消息）。
        const copiedHistory = await storage.loadHistory(targetConversationId);
        expect(copiedHistory).toHaveLength(3);
        expect(copiedHistory!.map(({ id, parentId, ...rest }) => rest))
            .toEqual(sourceHistory.slice(0, 3).map(({ id, parentId, ...rest }) => rest));
        expect(copiedHistory!.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(copiedHistory![0].parentId).toBeNull();
        expect(copiedHistory![1].parentId).toBe(copiedHistory![0].id);
        expect(copiedHistory![2].parentId).toBe(copiedHistory![1].id);

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

describe('ConversationManager rejectToolCalls with findFunctionResponseInsertIndex', () => {
    /** 构造一段历史：model 消息（含 tool calls），后续可能已有部分 functionResponse */
    function buildHistoryWithToolCalls(
        toolCalls: Array<{ id: string; name: string }>,
        existingResponses: Array<{ id: string; name: string }> = []
    ): ConversationHistory {
        const modelParts: ContentPart[] = toolCalls.map(tc => ({
            functionCall: { id: tc.id, name: tc.name, args: {} }
        }));
        const history: ConversationHistory = [
            { role: 'user', parts: [{ text: 'hello' }], timestamp: 100 },
            { role: 'model', parts: modelParts, timestamp: 200 }
        ];
        // 同批次已落库的 functionResponse（模拟部分工具先完成）
        for (const resp of existingResponses) {
            history.push({
                role: 'user',
                parts: [{
                    functionResponse: { id: resp.id, name: resp.name, response: { success: true } }
                }],
                isFunctionResponse: true,
                timestamp: 300
            });
        }
        return history;
    }

    test('inserts rejected response after existing function responses (same batch order)', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'test-conv';

        // model 输出 A, B, C 三个 tool call，B 和 C 已先落库
        const history = buildHistoryWithToolCalls(
            [{ id: 'A', name: 'toolA' }, { id: 'B', name: 'toolB' }, { id: 'C', name: 'toolC' }],
            [{ id: 'B', name: 'toolB' }, { id: 'C', name: 'toolC' }]
        );
        await storage.saveHistory(convId, history);

        // 拒绝 tool A
        await manager.rejectToolCalls(convId, 1, ['A']);

        const result = await storage.loadHistory(convId);
        // messages 2, 3: existing B, C responses; message 4: rejected A response
        expect(result!.length).toBe(5);
        expect(result![1].parts![0].functionCall!.rejected).toBe(true);
        expect(result![2].parts![0].functionResponse!.id).toBe('B');
        expect(result![3].parts![0].functionResponse!.id).toBe('C');
        expect(result![4].parts![0].functionResponse!.id).toBe('A');
        expect(result![4].parts![0].functionResponse!.response).toMatchObject({ success: false, rejected: true });
        expect(result![2].isFunctionResponse).toBe(true);
        expect(result![3].isFunctionResponse).toBe(true);
        expect(result![4].isFunctionResponse).toBe(true);
    });

    test('inserts rejected response right after tool call when no existing responses', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'test-conv';

        const history = buildHistoryWithToolCalls([{ id: 'A', name: 'toolA' }]);
        await storage.saveHistory(convId, history);

        await manager.rejectToolCalls(convId, 1, ['A']);

        const result = await storage.loadHistory(convId);
        expect(result!.length).toBe(3);
        expect(result![2].parts![0].functionResponse!.id).toBe('A');
        expect(result![2].isFunctionResponse).toBe(true);
    });

    test('rejectAllPendingToolCalls inserts responses preserving tool call order', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'test-conv';

        const history = buildHistoryWithToolCalls([
            { id: 'X', name: 'toolX' },
            { id: 'Y', name: 'toolY' },
            { id: 'Z', name: 'toolZ' }
        ], [{ id: 'Y', name: 'toolY' }]); // Y already responded
        await storage.saveHistory(convId, history);

        await manager.rejectAllPendingToolCalls(convId);

        const result = await storage.loadHistory(convId);
        // messages: 0=user, 1=model, 2=resp Y(existing), 3=resp X+Z(rejected in one message, 2 parts)
        expect(result!.length).toBe(4);
        // Only pending (unresponded) calls X and Z are rejected; Y already has a response
        const calls = result![1].parts!.filter(p => p.functionCall);
        expect(calls.length).toBe(3);
        expect(calls.find(p => p.functionCall!.id === 'X')!.functionCall!.rejected).toBe(true);
        expect(calls.find(p => p.functionCall!.id === 'Z')!.functionCall!.rejected).toBe(true);
        // Y already had response, so it was NOT marked as rejected
        expect(calls.find(p => p.functionCall!.id === 'Y')!.functionCall!.rejected).toBeFalsy();
        // Y response remains (was already in history before rejectAll)
        expect(result![2].parts![0].functionResponse!.id).toBe('Y');
        // X and Z rejected responses: inserted after Y, grouped in one message
        expect(result![3].parts!.length).toBe(2);
        expect(result![3].parts![0].functionResponse!.id).toBe('X');
        expect(result![3].parts![1].functionResponse!.id).toBe('Z');
    });
});
