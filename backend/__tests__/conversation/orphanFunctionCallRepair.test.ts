import { ConversationManager } from '../../modules/conversation';
import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';
import { MemoryStorageAdapter } from '../../modules/conversation';
import {
    deleteLogicalMessage,
    repairFunctionCallPairsAfterDelete,
    truncateFrom,
} from '../../modules/conversation/TranscriptMutation';
import type { Content } from '../../modules/conversation';

function functionCallMessage(
    id: string,
    options: { messageId?: string; parentId?: string | null; rejected?: boolean } = {},
): Content {
    return {
        id: options.messageId,
        parentId: options.parentId,
        role: 'model',
        parts: [{
            functionCall: {
                id,
                name: 'search_in_files',
                args: { query: 'needle' },
                ...(options.rejected ? { rejected: true } : {}),
            },
        }],
    } as Content;
}

function functionResponseMessage(
    id: string,
    options: { messageId?: string; parentId?: string | null; success?: boolean } = {},
): Content {
    return {
        id: options.messageId,
        parentId: options.parentId,
        role: 'user',
        isFunctionResponse: true,
        parts: [{
            functionResponse: {
                id,
                name: 'search_in_files',
                response: { success: options.success ?? true },
            },
        }],
    } as Content;
}

function expectValidToolHistory(history: Content[]): void {
    expect(validateHistoryIntegrity(history, { detectOrphanFunctionCall: true })).toEqual({
        valid: true,
        issues: [],
    });
}

describe('删除历史后的 functionCall/functionResponse 配对修复', () => {
    test('truncateFrom 删除后缀中的响应时，将保留的调用标记 rejected 且不伪造用户拒绝响应', () => {
        // 真实编辑分支形态：目标 user 的 parentId 指向 functionCall 消息，真实响应稍后落在目标消息之后。
        const history: Content[] = [
            { id: 'u1', parentId: null, role: 'user', parts: [{ text: 'run tool' }] } as Content,
            functionCallMessage('call-1', { messageId: 'fc1', parentId: 'u1' }),
            { id: 'u2', parentId: 'fc1', role: 'user', parts: [{ text: 'edit me' }] } as Content,
            functionResponseMessage('call-1', { messageId: 'fr1', parentId: 'u2' }),
        ];

        const result = truncateFrom(history, 2);

        expect(result.map(message => message.id)).toEqual(['u1', 'fc1']);
        expect(result[1].parts[0].functionCall?.rejected).toBe(true);
        expect(result.flatMap(message => message.parts).some(part => part.functionResponse)).toBe(false);
        expectValidToolHistory(result);
    });

    test('deleteMessagesInRange 覆盖编辑分支截断场景，请求前不再出现 orphan_function_call', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const conversationId = 'conv-orphan-edit-branch';
        await manager.createConversation(conversationId, 'orphan regression');
        await storage.saveHistory(conversationId, [
            { id: 'u1', parentId: null, role: 'user', parts: [{ text: 'run tool' }] } as Content,
            functionCallMessage('call-1', { messageId: 'fc1', parentId: 'u1' }),
            { id: 'u2', parentId: 'fc1', role: 'user', parts: [{ text: 'old prompt' }] } as Content,
            functionResponseMessage('call-1', { messageId: 'fr1', parentId: 'u2' }),
            { id: 'm2', parentId: 'fr1', role: 'model', parts: [{ text: 'old answer' }] } as Content,
        ]);

        // handleEditBranchStream 会保留 parent=fc1，并删除其后的旧分支。
        await manager.deleteMessagesInRange(conversationId, 2, 4);
        await manager.addContent(conversationId, {
            id: 'u2-edited',
            role: 'user',
            parts: [{ text: 'edited prompt' }],
            isUserInput: true,
        } as Content);

        const result = await manager.getMessagesRaw(conversationId);
        expect(result.map(message => message.id)).toEqual(['u1', 'fc1', 'u2-edited']);
        expect(result[1].parts[0].functionCall?.rejected).toBe(true);
        expectValidToolHistory(result);
    });

    test('deleteLogicalMessage 只删除响应时也会修复保留的调用', () => {
        const history: Content[] = [
            functionCallMessage('call-1', { messageId: 'fc1', parentId: null }),
            functionResponseMessage('call-1', { messageId: 'fr1', parentId: 'fc1' }),
            { id: 'u2', parentId: 'fr1', role: 'user', parts: [{ text: 'continue' }] } as Content,
        ];

        const result = deleteLogicalMessage(history, 1);

        expect(result.map(message => message.id)).toEqual(['fc1', 'u2']);
        expect(result[0].parts[0].functionCall?.rejected).toBe(true);
        expect(result[1].parentId).toBe('fc1');
        expectValidToolHistory(result);
    });

    test('同 id 的其它响应仍保留时不误标；并行调用只修复真正失去响应的一个', () => {
        const remaining: Content[] = [{
            role: 'model',
            parts: [
                { functionCall: { id: 'call-a', name: 'a', args: {} } },
                { functionCall: { id: 'call-b', name: 'b', args: {} } },
            ],
        }, functionResponseMessage('call-b') as Content];
        const deleted = [functionResponseMessage('call-a'), functionResponseMessage('call-b')];

        const repairedCount = repairFunctionCallPairsAfterDelete(remaining, deleted);

        expect(repairedCount).toBe(1);
        expect(remaining[0].parts[0].functionCall?.rejected).toBe(true);
        expect(remaining[0].parts[1].functionCall?.rejected).toBeFalsy();
        expectValidToolHistory(remaining);
    });
});

describe('settleFunctionResponses 截断时序加固', () => {
    test('截断已将调用标记 rejected 后，迟到的真实响应落盘并清除 rejected', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const conversationId = 'conv-settle-after-truncate';
        await manager.createConversation(conversationId, 'settle regression');
        await storage.saveHistory(conversationId, [
            { id: 'u1', parentId: null, role: 'user', parts: [{ text: 'run tool' }] } as Content,
            functionCallMessage('call-1', { messageId: 'fc1', parentId: 'u1', rejected: true }),
        ]);

        await manager.settleFunctionResponses(conversationId, [
            functionResponseMessage('call-1').parts[0],
        ]);

        const result = await manager.getMessagesRaw(conversationId);
        expect(result).toHaveLength(3);
        expect(result[1].parts[0].functionCall?.rejected).toBe(false);
        expect(result[2].parts[0].functionResponse?.response).toEqual({ success: true });
        expectValidToolHistory(result);
    });

    test('functionCall 已被截断时丢弃迟到响应，不追加 orphan_function_response', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const conversationId = 'conv-settle-after-call-deleted';
        await manager.createConversation(conversationId, 'stale settle');
        await storage.saveHistory(conversationId, [
            { id: 'u1', parentId: null, role: 'user', parts: [{ text: 'kept history' }] } as Content,
        ]);

        await manager.settleFunctionResponses(conversationId, [
            functionResponseMessage('deleted-call').parts[0],
        ]);

        const result = await manager.getMessagesRaw(conversationId);
        expect(result).toHaveLength(1);
        expect(result.flatMap(message => message.parts).some(part => part.functionResponse)).toBe(false);
        expectValidToolHistory(result);
    });
});
