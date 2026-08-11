/**
 * BR-01 / BR-02：稳定消息节点 ID 与旧历史惰性补 ID（幂等迁移）。
 *
 * 覆盖：
 * - BR-01：所有写入路径（addMessage/addContent/addBatch/insertContent/insertMessage/
 *   settleFunctionResponses/rejectToolCalls/rejectAllPendingToolCalls/normalizeHistoryForDisplay）
 *   统一补 id + 线性 parentId；
 * - BR-01：getMessages / getMessagesPaged 透出 id；
 * - BR-01：formatHistoryForAPI 白名单过滤，不发送 id/parentId；
 * - BR-02：读取入口检测缺 id → 写锁内确定性补 ID + 线性 parentId 全量重写；
 * - BR-02：幂等（同一历史多次迁移产出同一 ID 集合；迁移后不再重写）；
 * - BR-02：迁移后 totalMessages 不变；迁移失败抛错且不留下部分状态。
 */

import { ConversationManager, deterministicNodeId } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { StorageHistoryPage, StorageReadResult } from '../../modules/conversation/storage';
import type { Content, ConversationHistory } from '../../modules/conversation';
import { makeContent } from '../__fixtures__/conversationFixtures';

/** 典型旧历史：所有消息都没有 id/parentId */
function legacyHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'hello' }], isUserInput: true, timestamp: 1000 },
        { role: 'model', parts: [{ text: 'hi' }], timestamp: 2000 },
        { role: 'user', parts: [{ text: 'again' }], isUserInput: true, timestamp: 3000 },
    ] as ConversationHistory;
}

/** 模拟分段存储：走 getMessagesPaged 的 format === 'paged' 快路径 */
class PagedMemoryStorageAdapter extends MemoryStorageAdapter {
    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const result = await super.loadHistoryPage(conversationId, options);
        if (result.value) {
            result.value.format = 'paged';
        }
        return result;
    }
}

/** saveHistory 抛错的适配器：验证迁移失败不落盘（原子性） */
class FailingSaveStorageAdapter extends MemoryStorageAdapter {
    failSave = false;

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        if (this.failSave) {
            throw new Error('simulated save failure');
        }
        return await super.saveHistory(conversationId, history);
    }
}

describe('deterministicNodeId（BR-02 确定性生成）', () => {
    test('同一 (namespace, seed) 产出同一 ID，不同 seed 产出不同 ID', () => {
        const a1 = deterministicNodeId('conv-1', 'user|0|1000');
        const a2 = deterministicNodeId('conv-1', 'user|0|1000');
        expect(a1).toBe(a2);
        expect(deterministicNodeId('conv-2', 'user|0|1000')).not.toBe(a1);
        expect(deterministicNodeId('conv-1', 'user|1|1000')).not.toBe(a1);
        expect(deterministicNodeId('conv-1', 'model|0|1000')).not.toBe(a1);
        // UUID 格式
        expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('写入路径统一补 ID（BR-01）', () => {
    test('addMessage 生成 id 且首条 parentId 为 null，追加链式 parentId', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-w1', 'W1');
        await manager.addMessage('conv-w1', 'user', [{ text: 'a' }], { isUserInput: true });
        await manager.addMessage('conv-w1', 'user', [{ text: 'b' }], { isUserInput: true });

        const history = await manager.getHistory('conv-w1');
        expect(history).toHaveLength(2);
        expect(typeof history[0].id).toBe('string');
        expect(history[0].id!.length).toBeGreaterThan(0);
        expect(history[0].parentId).toBeNull();
        expect(history[1].id).toBeTruthy();
        expect(history[1].parentId).toBe(history[0].id);
    });

    test('addContent / addBatch 同样补 id + 线性 parentId', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-w2', 'W2');
        await manager.addContent('conv-w2', makeContent('user', 'u1'));
        await manager.addBatch('conv-w2', [
            makeContent('model', 'm1'),
            makeContent('user', 'u2'),
        ]);

        const history = await manager.getHistory('conv-w2');
        expect(history).toHaveLength(3);
        expect(history[0].parentId).toBeNull();
        expect(history[1].parentId).toBe(history[0].id);
        expect(history[2].parentId).toBe(history[1].id);
    });

    test('addContent functionResponse 补 id 且 parentId 指向工具调用消息', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-w3', 'W3');
        await manager.addContent('conv-w3', makeContent('model', '', {
            parts: [{ functionCall: { id: 'tool-1', name: 'read_file', args: '{}' } }]
        }));
        await manager.addContent('conv-w3', makeContent('user', '', {
            isFunctionResponse: true,
            parts: [{ functionResponse: { id: 'tool-1', name: 'read_file', response: { success: true } } }]
        }));

        const history = await manager.getHistory('conv-w3');
        expect(history).toHaveLength(2);
        const fr = history[1];
        expect(fr.isFunctionResponse).toBe(true);
        expect(fr.id).toBeTruthy();
        expect(fr.parentId).toBe(history[0].id);
    });

    test('insertContent / insertMessage 补 id 且 parentId 指向插入位置前一条', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-w4', 'W4');
        await manager.addBatch('conv-w4', [makeContent('user', 'a'), makeContent('model', 'b')]);

        await manager.insertContent('conv-w4', 1, makeContent('user', 'inserted'));
        await manager.insertMessage('conv-w4', 3, 'user', [{ text: 'inserted2' }]);

        const history = await manager.getHistory('conv-w4');
        expect(history).toHaveLength(4);
        expect(history[1].parts[0]).toEqual({ text: 'inserted' });
        expect(history[1].id).toBeTruthy();
        expect(history[1].parentId).toBe(history[0].id);
        expect(history[3].parts[0]).toEqual({ text: 'inserted2' });
        expect(history[3].id).toBeTruthy();
        expect(history[3].parentId).toBe(history[2].id);
    });

    test('settleFunctionResponses 新追加的 functionResponse 补 id + parentId', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-w5', 'W5');
        await manager.addContent('conv-w5', makeContent('model', 'planning', {
            parts: [{ functionCall: { id: 'call-x', name: 'search_in_files', args: '{}' } }]
        }));

        await manager.settleFunctionResponses('conv-w5', [
            { functionResponse: { id: 'call-x', name: 'search_in_files', response: { success: true } } }
        ]);

        const history = await manager.getHistory('conv-w5');
        expect(history).toHaveLength(2);
        expect(history[1].isFunctionResponse).toBe(true);
        expect(history[1].id).toBeTruthy();
        expect(history[1].parentId).toBe(history[0].id);
    });

    test('normalizeHistoryForDisplay 插入的 rejected functionResponse 补 id + parentId', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-w6', [
            { role: 'user', parts: [{ text: 'go' }], isUserInput: true, timestamp: 100 },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: '{}' } }],
                timestamp: 200
            }
        ] as ConversationHistory);

        const messages = await manager.getMessages('conv-w6');
        const inserted = messages.find(m => m.isFunctionResponse);
        expect(inserted).toBeDefined();
        expect(inserted!.id).toBeTruthy();
        expect(inserted!.parentId).toBe(messages[1].id);

        // 已落盘
        const persisted = await storage.loadHistory('conv-w6');
        const persistedFr = persisted!.find(m => m.isFunctionResponse);
        expect(persistedFr!.id).toBe(inserted!.id);
    });

    test('rejectToolCalls 插入的 functionResponse 补 id + parentId', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-w7', [
            { role: 'user', parts: [{ text: 'go' }], isUserInput: true, timestamp: 100 },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'call-2', name: 'read_file', args: '{}' } }],
                timestamp: 200
            }
        ] as ConversationHistory);

        await manager.rejectToolCalls('conv-w7', 1);
        const history = await manager.getHistory('conv-w7');
        expect(history).toHaveLength(3);
        expect(history[2].isFunctionResponse).toBe(true);
        expect(history[2].id).toBeTruthy();
        expect(history[2].parentId).toBe(history[1].id);
    });
});

describe('读取路径透出 id（BR-01）', () => {
    test('getMessages 返回的每条消息带 id', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-r1', 'R1');
        await manager.addMessage('conv-r1', 'user', [{ text: 'a' }]);
        await manager.addMessage('conv-r1', 'model', [{ text: 'b' }]);

        const messages = await manager.getMessages('conv-r1');
        expect(messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(messages[0].parentId).toBeNull();
        expect(messages[1].parentId).toBe(messages[0].id);
    });

    test('getMessagesPaged 返回的每条消息带 id（内存适配器）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-r2', 'R2');
        await manager.addBatch('conv-r2', [makeContent('user', 'a'), makeContent('model', 'b')]);

        const page = await manager.getMessagesPaged('conv-r2');
        expect(page.messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(page.messages[1].parentId).toBe(page.messages[0].id);
    });

    test('getMessagesPaged 返回的每条消息带 id（分段存储快路径）', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-r3', 'R3');
        await manager.addBatch('conv-r3', [makeContent('user', 'a'), makeContent('model', 'b')]);

        const page = await manager.getMessagesPaged('conv-r3');
        expect(page.messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    });
});

describe('formatHistoryForAPI 不发送 id/parentId（BR-01）', () => {
    test('API 历史中不包含 id/parentId，常规字段保留', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-api', 'API');
        await manager.addMessage('conv-api', 'user', [{ text: 'hello' }], { isUserInput: true });
        await manager.addMessage('conv-api', 'model', [{ text: 'world' }]);

        const forApi = await manager.getHistoryForAPI('conv-api');
        expect(forApi).toHaveLength(2);
        for (const message of forApi) {
            expect(message).not.toHaveProperty('id');
            expect(message).not.toHaveProperty('parentId');
        }
        expect(forApi[0].role).toBe('user');
        expect(forApi[0].parts[0]).toEqual({ text: 'hello' });
    });

    test('getHistoryForAPIFrom 同样不包含 id/parentId', () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const withIds: ConversationHistory = [
            { role: 'user', parts: [{ text: 'a' }], id: 'n1', parentId: null, timestamp: 1 },
            { role: 'model', parts: [{ text: 'b' }], id: 'n2', parentId: 'n1', timestamp: 2 },
        ];
        const forApi = manager.getHistoryForAPIFrom(withIds);
        expect(forApi).toHaveLength(2);
        for (const message of forApi) {
            expect(message).not.toHaveProperty('id');
            expect(message).not.toHaveProperty('parentId');
        }
    });
});

describe('旧历史惰性补 ID（BR-02）', () => {
    test('getMessagesPaged 首次加载触发迁移：确定性 ID + 线性 parentId，total 不变', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m1', legacyHistory());

        const page = await manager.getMessagesPaged('conv-m1');
        expect(page.total).toBe(3);
        const ids = page.messages.map(m => m.id);
        expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(page.messages[0].parentId).toBeNull();
        expect(page.messages[1].parentId).toBe(ids[0]);
        expect(page.messages[2].parentId).toBe(ids[1]);

        // 迁移已落盘
        const persisted = await storage.loadHistory('conv-m1');
        expect(persisted).toHaveLength(3);
        expect(persisted!.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    });

    test('幂等硬要求：同一历史多次迁移产出同一 ID 集合', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m2', legacyHistory());

        const first = await manager.getMessagesPaged('conv-m2');
        const firstIds = first.messages.map(m => m.id);
        const second = await manager.getMessagesPaged('conv-m2');
        const secondIds = second.messages.map(m => m.id);
        expect(secondIds).toEqual(firstIds);

        // 直接调用迁移方法两次：ID 集合一致
        const migrated1 = await storage.loadHistory('conv-m2');
        await manager.ensureHistoryNodeIds('conv-m2');
        const migrated2 = await storage.loadHistory('conv-m2');
        expect(migrated2!.map(m => m.id)).toEqual(migrated1!.map(m => m.id));
        expect(migrated2!.map(m => m.parentId)).toEqual(migrated1!.map(m => m.parentId));
    });

    test('迁移后不再重写：第二次读取不调用 saveHistory（自判定幂等）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m3', legacyHistory());

        const saveSpy = jest.spyOn(storage, 'saveHistory');
        await manager.getMessagesPaged('conv-m3');
        expect(saveSpy).toHaveBeenCalledTimes(1); // 迁移写一次

        saveSpy.mockClear();
        await manager.getMessagesPaged('conv-m3');
        await manager.getMessages('conv-m3');
        await manager.getHistory('conv-m3');
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('getHistory / getMessages 入口同样触发惰性迁移', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m4', legacyHistory());

        const history = await manager.getHistory('conv-m4');
        expect(history.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(history[1].parentId).toBe(history[0].id);

        const storage2 = new MemoryStorageAdapter();
        const manager2 = new ConversationManager(storage2);
        await storage2.saveHistory('conv-m5', legacyHistory());
        const messages = await manager2.getMessages('conv-m5');
        expect(messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(messages[2].parentId).toBe(messages[1].id);
    });

    test('部分迁移的历史：已有 id 保留、缺 id 确定性补齐、parentId 统一补线性链', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m6', [
            { role: 'user', parts: [{ text: 'a' }], timestamp: 100 }, // 无 id
            { role: 'model', parts: [{ text: 'b' }], id: 'keep-me', timestamp: 200 }, // 有 id 无 parentId
            { role: 'user', parts: [{ text: 'c' }], timestamp: 300 }, // 无 id
        ] as ConversationHistory);

        const migrated = await manager.ensureHistoryNodeIds('conv-m6');
        expect(migrated).toBe(true);
        const history = await storage.loadHistory('conv-m6');
        expect(history![1].id).toBe('keep-me');
        expect(history![0].id).not.toBe('keep-me');
        expect(history![0].parentId).toBeNull();
        expect(history![1].parentId).toBe(history![0].id);
        expect(history![2].parentId).toBe('keep-me');
        expect(history).toHaveLength(3);

        // 再次迁移：不再触发
        const again = await manager.ensureHistoryNodeIds('conv-m6');
        expect(again).toBe(false);
    });

    test('分段存储快路径（format=paged）也触发迁移', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m7', legacyHistory());

        const page = await manager.getMessagesPaged('conv-m7');
        expect(page.total).toBe(3);
        expect(page.messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(page.messages[1].parentId).toBe(page.messages[0].id);
    });

    test('悬空工具调用 + 缺 id 并存：先补 functionResponse（带 id），再迁移', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m8', [
            { role: 'user', parts: [{ text: 'go' }], isUserInput: true, timestamp: 100 },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: '{}' } }],
                timestamp: 200
            }
        ] as ConversationHistory);

        const page = await manager.getMessagesPaged('conv-m8');
        expect(page.total).toBe(3); // 原 2 条 + 插入的 rejected functionResponse
        expect(page.messages.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        const inserted = page.messages[2];
        expect(inserted.isFunctionResponse).toBe(true);
        expect(inserted.parentId).toBe(page.messages[1].id);
    });

    test('迁移失败抛错且不留下部分迁移状态（原子性/回滚）', async () => {
        const storage = new FailingSaveStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-m9', legacyHistory());

        storage.failSave = true;
        await expect(manager.ensureHistoryNodeIds('conv-m9')).rejects.toThrow(/simulated save failure/);

        // 落盘数据仍是迁移前形态（无 id）
        const persisted = await storage.loadHistory('conv-m9');
        expect(persisted).toHaveLength(3);
        expect(persisted!.every(m => m.id === undefined)).toBe(true);
    });

    test('createBranchConversation 先迁移源历史，分支复制内容带 id', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-src', legacyHistory());
        await storage.saveMetadata({ id: 'conv-src', title: 'Source', createdAt: 1, updatedAt: 1, custom: {} });

        const result = await manager.createBranchConversation('conv-src', 1);
        expect(result.messageCount).toBe(2);

        const branch = await storage.loadHistory(result.conversationId);
        expect(branch!.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
        expect(branch![1].parentId).toBe(branch![0].id);
        // 源历史也被迁移
        const source = await storage.loadHistory('conv-src');
        expect(source!.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    });
});
