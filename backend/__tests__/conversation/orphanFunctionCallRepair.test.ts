import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';
import {
    deleteLogicalMessage,
    repairFunctionCallPairsAfterDelete,
    truncateFrom,
} from '../../modules/conversation/TranscriptMutation';
import type { Content } from '../../modules/conversation/types';

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
