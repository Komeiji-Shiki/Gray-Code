/**
 * FIX-G1 R5b-2.4：删除中间消息后修复线性 parentId 链。
 *
 * 覆盖：
 * - deleteLogicalMessage 删除中间消息（含配对 functionResponse）后，直系后继
 *   parentId 重链到被删消息的 parent（不再悬空指向已删除 id）；
 * - deleteMessagesInRange 删除中间范围后同样重链；
 * - 连续删除（target + 紧随其后的 functionResponse 一起删）时沿链向上解析到
 *   最近未删除祖先；
 * - 分支语义保留：parentId 指向未删除消息的跨链关系不受影响；
 * - 首条删除时后继重链为 null（根）。
 */

import {
    deleteLogicalMessage,
    repairParentChainAfterDelete
} from '../../modules/conversation/TranscriptMutation';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { Content } from '../../modules/conversation/types';

interface ChainNode {
    id: string;
    parentId: string | null;
    role: string;
    isFunctionResponse?: boolean;
}

function node({ id, parentId, role, isFunctionResponse }: ChainNode): Content {
    return {
        role,
        parts: [{ text: id }],
        id,
        parentId,
        ...(isFunctionResponse ? { isFunctionResponse: true } : {})
    } as Content;
}

describe('repairParentChainAfterDelete（R5b-2.4）', () => {
    test('被删消息的直系后继重链到被删消息的 parent；其余消息原样保留', () => {
        // a(根) → b → c(被删) → d(后继) → e
        const remaining = [
            node({ id: 'a', parentId: null, role: 'user' }),
            node({ id: 'b', parentId: 'a', role: 'model' }),
            node({ id: 'd', parentId: 'c', role: 'user', isFunctionResponse: true }),
            node({ id: 'e', parentId: 'd', role: 'model' })
        ];
        repairParentChainAfterDelete(remaining, [node({ id: 'c', parentId: 'b', role: 'user' })]);

        expect(remaining[0].parentId).toBeNull(); // a 不变
        expect(remaining[1].parentId).toBe('a');  // b 不变
        expect(remaining[2].parentId).toBe('b');  // d: c→b（重链）
        expect(remaining[3].parentId).toBe('d');  // e 不变
    });

    test('连续删除时沿链向上解析到最近未删除祖先', () => {
        // a(根) → b(被删) → c(被删) → d(后继)
        const remaining = [
            node({ id: 'a', parentId: null, role: 'user' }),
            node({ id: 'd', parentId: 'c', role: 'user', isFunctionResponse: true })
        ];
        repairParentChainAfterDelete(remaining, [
            node({ id: 'b', parentId: 'a', role: 'model' }),
            node({ id: 'c', parentId: 'b', role: 'user', isFunctionResponse: true })
        ]);

        expect(remaining[1].parentId).toBe('a'); // d: c → b → a
    });

    test('首条被删时后继重链为 null（根）', () => {
        const remaining = [
            node({ id: 'b', parentId: 'a', role: 'model' })
        ];
        repairParentChainAfterDelete(remaining, [node({ id: 'a', parentId: null, role: 'user' })]);
        expect(remaining[0].parentId).toBeNull();
    });

    test('分支语义保留：parentId 指向未删除消息的跨链关系不受影响', () => {
        // 主链 a → b → c(被删) → d；分支 x 挂在 b 上（跨链）
        const remaining = [
            node({ id: 'a', parentId: null, role: 'user' }),
            node({ id: 'b', parentId: 'a', role: 'model' }),
            node({ id: 'd', parentId: 'c', role: 'user', isFunctionResponse: true }),
            node({ id: 'x', parentId: 'b', role: 'model' }) // 分支挂点，parent 未删
        ];
        repairParentChainAfterDelete(remaining, [node({ id: 'c', parentId: 'b', role: 'user' })]);

        expect(remaining[2].parentId).toBe('b'); // 主链直系后继重链
        expect(remaining[3].parentId).toBe('b'); // 分支跨链不变
    });

    test('无 id 的被删消息不参与重链（跳过），空删除为 no-op', () => {
        const remaining = [node({ id: 'd', parentId: 'c', role: 'user' })];
        repairParentChainAfterDelete(remaining, [{ role: 'user', parts: [] } as Content]);
        expect(remaining[0].parentId).toBe('c');

        repairParentChainAfterDelete(remaining, []);
        expect(remaining[0].parentId).toBe('c');
    });
});

describe('deleteLogicalMessage 修复 parentId 链（R5b-2.4）', () => {
    test('删除中间消息（含配对 functionResponse）后直系后继重链', () => {
        const contents: Content[] = [
            node({ id: 'u1', parentId: null, role: 'user' }),
            node({ id: 'm1', parentId: 'u1', role: 'model' }),
            node({ id: 'fr1', parentId: 'm1', role: 'user', isFunctionResponse: true }),
            node({ id: 'u2', parentId: 'fr1', role: 'user' }),
            node({ id: 'm2', parentId: 'u2', role: 'model' })
        ];
        // 删除带 functionCall 的消息：模拟 functionCall part
        (contents[1] as any).parts = [{ functionCall: { id: 'call_1', name: 'x', args: {} } }];
        // fr1 是对应 functionResponse
        (contents[2] as any).parts = [{ functionResponse: { id: 'call_1', name: 'x', response: { success: true } } }];

        const result = deleteLogicalMessage(contents, 1);

        // 删除 m1 + fr1；剩余 u1, u2, m2
        expect(result.map(m => m.id)).toEqual(['u1', 'u2', 'm2']);
        // u2 的 parentId 从 fr1 重链到 u1（m1 的 parent）
        expect(result[1].id).toBe('u2');
        expect(result[1].parentId).toBe('u1');
        expect(result[2].id).toBe('m2');
        expect(result[2].parentId).toBe('u2');
        // index 重新连续
        expect(result.map(m => m.index)).toEqual([0, 1, 2]);
    });

    test('删除末尾消息：无后继，链不受影响', () => {
        const contents: Content[] = [
            node({ id: 'u1', parentId: null, role: 'user' }),
            node({ id: 'm1', parentId: 'u1', role: 'model' })
        ];
        const result = deleteLogicalMessage(contents, 1);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('u1');
        expect(result[0].parentId).toBeNull();
    });
});

describe('deleteMessagesInRange 修复 parentId 链（R5b-2.4）', () => {
    test('删除中间范围后直系后继重链到范围前驱', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-g1-range', 'R');
        await manager.addMessage('conv-g1-range', 'user', [{ text: 'u1' }], { isUserInput: true });
        await manager.addMessage('conv-g1-range', 'model', [{ text: 'm1' }]);
        await manager.addMessage('conv-g1-range', 'user', [{ text: 'u2' }], { isUserInput: true });
        await manager.addMessage('conv-g1-range', 'model', [{ text: 'm2' }]);
        await manager.addMessage('conv-g1-range', 'user', [{ text: 'u3' }], { isUserInput: true });

        const before = await manager.getHistory('conv-g1-range');
        expect(before).toHaveLength(5);
        const deletedId = before[2].id!;
        const predecessorId = before[1].id!;
        const successorId = before[3].id!;
        // 线性链校验
        expect(before[3].parentId).toBe(deletedId);

        // 删除中间一条（索引 2）
        await manager.deleteMessagesInRange('conv-g1-range', 2, 2);

        const after = await manager.getHistory('conv-g1-range');
        expect(after).toHaveLength(4);
        const successor = after.find(m => m.id === successorId)!;
        expect(successor.parentId).toBe(predecessorId); // 重链到范围前驱
    });

    test('删除到首条时后继重链为 null', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-g1-range2', 'R2');
        await manager.addMessage('conv-g1-range2', 'user', [{ text: 'u1' }], { isUserInput: true });
        await manager.addMessage('conv-g1-range2', 'model', [{ text: 'm1' }]);

        const before = await manager.getHistory('conv-g1-range2');
        const firstId = before[0].id!;
        expect(before[1].parentId).toBe(firstId);

        await manager.deleteMessagesInRange('conv-g1-range2', 0, 0);

        const after = await manager.getHistory('conv-g1-range2');
        expect(after).toHaveLength(1);
        expect(after[0].parentId).toBeNull();
    });
});
