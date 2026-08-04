/**
 * BCP-01 测试：ConversationManager.getMessageNodeIdAt 反查辅助。
 *
 * 覆盖：
 * - 已带 id 的历史：按索引直接返回稳定节点 ID；
 * - 旧历史（无 id/parentId）：先触发 BR-02 惰性补 ID（确定性），再返回迁移后的 id；
 * - 索引越界（before 存档的“即将插入”位置 = history.length）与负索引：返回 undefined；
 * - 消息无 id（迁移兜底后仍有异常）时返回 undefined。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { Content } from '../../modules/conversation/types';

// 分支服务（branch/）正由其他批次并行改造中（reroll/互斥），本测试只关心
// ConversationManager.getMessageNodeIdAt，与分支图无关——mock 掉避免把
// 并行批次未完成的状态拖入本测试（该模块在 ConversationManager 中仅用于 BR-09 接线）。
jest.mock('../../modules/conversation/branch/BranchService', () => ({
    getGlobalBranchService: jest.fn(() => undefined),
    setGlobalBranchService: jest.fn()
}));

function makeMessage(role: 'user' | 'model', text: string, index: number, withId: boolean): Content {
    return {
        role,
        parts: [{ text }],
        timestamp: 1000 + index,
        ...(withId ? { id: `id-${index}`, parentId: index === 0 ? null : `id-${index - 1}` } : {})
    };
}

describe('BCP-01: ConversationManager.getMessageNodeIdAt', () => {
    test('历史已带 id：按索引返回稳定节点 ID', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-node-id', 'NodeId');

        const history = [makeMessage('user', 'hi', 0, true), makeMessage('model', 'hello', 1, true)];
        await storage.saveHistory('conv-node-id', history);

        await expect(manager.getMessageNodeIdAt('conv-node-id', 0)).resolves.toBe('id-0');
        await expect(manager.getMessageNodeIdAt('conv-node-id', 1)).resolves.toBe('id-1');
    });

    test('旧历史（无 id）：触发 BR-02 惰性补 ID 后返回确定性 id', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-node-legacy', 'Legacy');

        // 模拟 BR-02 之前的旧线性历史：无 id、无 parentId
        const legacy = [makeMessage('user', 'hi', 0, false), makeMessage('model', 'hello', 1, false)];
        await storage.saveHistory('conv-node-legacy', legacy);

        const nodeId = await manager.getMessageNodeIdAt('conv-node-legacy', 1);
        expect(typeof nodeId).toBe('string');
        expect(nodeId!.length).toBeGreaterThan(0);

        // 幂等：二次反查返回同一 id（迁移已落地，不再变更）
        const again = await manager.getMessageNodeIdAt('conv-node-legacy', 1);
        expect(again).toBe(nodeId);

        // 迁移后历史确实已补 id（BR-02 判据不再命中）
        const migrated = await manager.getMessagesRaw('conv-node-legacy');
        expect(migrated[0].id).toBeDefined();
        expect(migrated[1].id).toBe(nodeId);
        expect(migrated[1].parentId).toBe(migrated[0].id);
    });

    test('索引越界（before 存档的“即将插入”位置）返回 undefined，不阻塞', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-node-oob', 'OOB');

        const history = [makeMessage('user', 'hi', 0, true)];
        await storage.saveHistory('conv-node-oob', history);

        // history.length = 1，新消息将插入的位置 = 1 → 无消息 → undefined
        await expect(manager.getMessageNodeIdAt('conv-node-oob', 1)).resolves.toBeUndefined();
        // 负索引 / 非整数 → undefined
        await expect(manager.getMessageNodeIdAt('conv-node-oob', -1)).resolves.toBeUndefined();
        await expect(manager.getMessageNodeIdAt('conv-node-oob', 1.5)).resolves.toBeUndefined();
    });

    test('空历史（无消息可反查）返回 undefined（防御路径，不抛错）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-node-empty', 'Empty');

        await expect(manager.getMessageNodeIdAt('conv-node-empty', 0)).resolves.toBeUndefined();
    });
});
