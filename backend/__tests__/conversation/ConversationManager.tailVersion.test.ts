import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';

/**
 * 对话尾部版本（重roll 树状分叉）测试。
 *
 * 语义：用户在 AI 回答上「重新生成」时，当前回答及其后续内容保存为版本；
 * 新回答成为活跃尾部；版本之间可来回切换，任何切换都不会丢失当前尾部。
 */
describe('ConversationManager tail versions (re-roll branching)', () => {
    function buildHistory(): ConversationHistory {
        return [
            { role: 'user', parts: [{ text: 'hello' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'answer v1' }], timestamp: 200 },
            { role: 'user', parts: [{ text: 'follow up' }], timestamp: 300 },
            { role: 'model', parts: [{ text: 'follow up answer' }], timestamp: 400 }
        ];
    }

    test('saveTailVersion persists the tail from branchIndex', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail';

        await storage.saveHistory(convId, buildHistory());

        const result = await manager.saveTailVersion(convId, 1);

        expect(result.saved).toBe(true);
        expect(result.versionId).toBeTruthy();
        expect(result.versions).toHaveLength(1);
        expect(result.versions[0]).toMatchObject({
            branchIndex: 1,
            messageCount: 3,
            preview: 'answer v1'
        });
        // 列表返回的是无内容摘要
        expect(Object.keys(result.versions[0])).not.toContain('messages');

        const stored = await storage.loadTailVersions(convId);
        expect(stored).toHaveLength(1);
        expect(stored![0].messages).toEqual(buildHistory().slice(1));
    });

    test('identical tail is deduplicated (no duplicate versions)', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail-dedupe';

        await storage.saveHistory(convId, buildHistory());

        const first = await manager.saveTailVersion(convId, 1);
        const second = await manager.saveTailVersion(convId, 1);

        expect(second.saved).toBe(false);
        expect(second.versionId).toBe(first.versionId);
        expect(second.versions).toHaveLength(1);
    });

    test('saveTailVersion with empty tail is a no-op', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail-empty';

        await storage.saveHistory(convId, buildHistory());

        const result = await manager.saveTailVersion(convId, 4);
        expect(result.saved).toBe(false);
        expect(result.versions).toHaveLength(0);
    });

    test('restoreTailVersion swaps the tail and preserves the displaced tail', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail-switch';

        // 初始历史 = 分支点 1 处的 v1 尾部
        await storage.saveHistory(convId, buildHistory());
        const saved = await manager.saveTailVersion(convId, 1);
        const v1Id = saved.versionId!;

        // 模拟重roll：截断到分支点 1，生成新的 v2 尾部
        await manager.deleteToMessage(convId, 1);
        await manager.addContent(convId, { role: 'model', parts: [{ text: 'answer v2' }], timestamp: 500 });
        await manager.addContent(convId, { role: 'user', parts: [{ text: 'next' }], timestamp: 600 });

        // 切回 v1：当前 v2 尾部应先被保存（不丢失），再恢复 v1 尾部
        const restored = await manager.restoreTailVersion(convId, 1, v1Id);

        const historyAfter = await manager.getHistory(convId);
        // 注：deleteToMessage 的 truncateFrom 会给保留的消息写回 index 字段（既有行为），
        // 比较时剥离该派生字段，只校验真实内容。
        const stripIndex = (list: ReadonlyArray<Record<string, any>>) => list.map(m => {
            const { index: _index, ...rest } = m;
            return rest;
        });
        expect(stripIndex(historyAfter)).toEqual([
            { role: 'user', parts: [{ text: 'hello' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'answer v1' }], timestamp: 200 },
            { role: 'user', parts: [{ text: 'follow up' }], timestamp: 300 },
            { role: 'model', parts: [{ text: 'follow up answer' }], timestamp: 400 }
        ]);

        // 两个版本都在：v1（被恢复）+ v2（切换前自动保存）
        const versions = restored.versions;
        expect(versions).toHaveLength(2);
        expect(versions.some(v => v.id === v1Id && v.branchIndex === 1)).toBe(true);

        // 再切回 v2：v1 尾部同样不会丢失
        const v2Info = versions.find(v => v.id !== v1Id)!;
        await manager.restoreTailVersion(convId, 1, v2Info.id);
        const historyAfter2 = await manager.getHistory(convId);
        expect(historyAfter2[1]).toMatchObject({ role: 'model', parts: [{ text: 'answer v2' }] });
        expect(historyAfter2[historyAfter2.length - 1]).toMatchObject({ role: 'user', parts: [{ text: 'next' }] });
    });

    test('restoreTailVersion rejects unknown version or mismatched branch', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail-invalid';

        await storage.saveHistory(convId, buildHistory());

        await expect(manager.restoreTailVersion(convId, 1, 'does-not-exist')).rejects.toThrow('not found');

        const saved = await manager.saveTailVersion(convId, 2);
        await expect(manager.restoreTailVersion(convId, 1, saved.versionId!)).rejects.toThrow('not found');
    });

    test('deleteConversation removes stored tail versions', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const convId = 'conv-tail-delete';

        await storage.saveHistory(convId, buildHistory());
        await manager.saveTailVersion(convId, 1);

        await manager.deleteConversation(convId);

        const versions = await manager.listTailVersions(convId);
        expect(versions).toHaveLength(0);
    });
});
