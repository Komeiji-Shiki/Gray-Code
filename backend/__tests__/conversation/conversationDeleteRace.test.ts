/**
 * deleteConversation 与进行中流式写入的“删除后复活”竞态测试。
 *
 * 背景：deleteHistory 只在 storage 级写队列排队，保证“已排队的写先完成再删”；
 * 但删除后新发起的 append/mutate 会排到 delete 之后 → 重新创建 {id}/history/ 目录，
 * 会话以“无 meta 的幽灵”复活。
 *
 * 修复：ConversationManager 把会话 ID 记入已删除集合，append/mutate 入口短路；
 * 读路径（loadHistory 自动建会话）同样不复活；createConversation 同 ID 重建时撤销标记。
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { Content } from '../../modules/conversation';
import { createAdapter } from './helpers/fakeVscodeFs';
import { makeContent } from '../__fixtures__/conversationFixtures';

describe('deleteConversation 与流式写入的“删除后复活”竞态', () => {
    test('删除后新发起的 append 被短路：历史目录不被重新创建（无幽灵会话）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del', 'Del');
        await manager.addContent('conv-del', makeContent('user', 'before'));

        await manager.deleteConversation('conv-del');

        // 流式收尾的后续 append 应被短路（拒绝写入）
        await expect(manager.addContent('conv-del', makeContent('user', 'after-delete')))
            .rejects.toThrow(/has been deleted/);

        // 历史没有被重新创建
        const result = await adapter.loadHistoryWithStatus('conv-del');
        expect(result.value).toBeNull();
        // conversations 目录下没有 conv-del 目录（segmented 历史未复活）
        const convDirs = [...fake.dirs].filter(d => d.endsWith('/conv-del'));
        expect(convDirs).toHaveLength(0);
        // meta 也未复活
        expect(await adapter.loadMetadata('conv-del')).toBeNull();
    });

    test('删除后读取（getMessages/getHistory）不自动重建会话', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del2', 'Del2');
        await manager.deleteConversation('conv-del2');

        const messages = await manager.getMessages('conv-del2');
        expect(messages).toHaveLength(0);
        const history = await manager.getHistory('conv-del2');
        expect(history).toHaveLength(0);
        // 未自动创建（meta 不存在）
        expect(await adapter.loadMetadata('conv-del2')).toBeNull();
    });

    test('mutate 路径（functionResponse 追加）同样被短路', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del4', 'Del4');
        await manager.deleteConversation('conv-del4');

        const fr = makeContent('user', '', {
            isFunctionResponse: true,
            parts: [{ functionResponse: { id: 't1', name: 'read_file', response: { success: true } } }]
        });
        await expect(manager.addContent('conv-del4', fr)).rejects.toThrow(/has been deleted/);
        const result = await adapter.loadHistoryWithStatus('conv-del4');
        expect(result.value).toBeNull();
    });

    test('删除后显式重建（createConversation 同 ID）恢复正常写入', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del3', 'Del3');
        await manager.deleteConversation('conv-del3');

        await manager.createConversation('conv-del3', 'Reborn');
        await manager.addContent('conv-del3', makeContent('user', 'alive'));
        const history = await manager.getHistory('conv-del3');
        expect(history).toHaveLength(1);
    });

    test('append 在 storage 入队窗口内 delete：会话写锁串行，不产生幽灵会话（R2 3.2）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-race6', 'Race6');
        await manager.addContent('conv-race6', makeContent('user', 'one'));

        // 模拟「断言未删 → 读尾 → 入队 storage 写」窗口：appendHistory 挂起。
        // 旧实现 delete 不入会话写锁，会滑入该窗口先删后写 → 历史目录被重新创建（幽灵）。
        let releaseAppend: () => void = () => {};
        let appendStartedResolve: () => void = () => {};
        const appendStarted = new Promise<void>(r => { appendStartedResolve = r; });
        const originalAppend = adapter.appendHistory!.bind(adapter);
        (adapter as any).appendHistory = async (id: string, contents: Content[]) => {
            appendStartedResolve();
            await new Promise<void>(r => { releaseAppend = r; });
            await originalAppend(id, contents);
        };

        const appendPromise = manager.addContent('conv-race6', makeContent('user', 'two'));
        await appendStarted; // append 已进入 storage 写（挂起在写队列任务内）
        const deletePromise = manager.deleteConversation('conv-race6');
        // delete 必须等待在途 append 完成（会话写锁串行），而不是先删后写复活
        releaseAppend();
        await Promise.all([appendPromise, deletePromise]);

        // 会话被删除：无幽灵历史/目录/meta
        const result = await adapter.loadHistoryWithStatus('conv-race6');
        expect(result.value).toBeNull();
        const convDirs = [...fake.dirs].filter(d => d.endsWith('/conv-race6'));
        expect(convDirs).toHaveLength(0);
        expect(await adapter.loadMetadata('conv-race6')).toBeNull();
    });

    test('删除失败（存储抛错）时撤销已删除标记，会话仍可用', async () => {
        const storage = new MemoryStorageAdapter();
        const original = storage.deleteHistory.bind(storage);
        (storage as any).deleteHistory = async () => { throw new Error('simulated delete failure'); };
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-del5', 'Del5');

        await expect(manager.deleteConversation('conv-del5')).rejects.toThrow(/simulated delete failure/);
        (storage as any).deleteHistory = original;

        // 标记已撤销：追加仍可用
        await manager.addContent('conv-del5', makeContent('user', 'still works'));
        const history = await manager.getHistory('conv-del5');
        expect(history).toHaveLength(1);
    });

    test('删除后元数据写路径（setTitle/updateSummary/setCustomMetadata）不重建 meta.json（无幽灵 meta）', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del-meta', 'Meta');
        // 删除前元数据写正常
        await manager.setTitle('conv-del-meta', 'Renamed');
        await manager.deleteConversation('conv-del-meta');

        // 删除后基于 not_found 的重建应被拒绝（跳过重建，不落盘 meta.json）
        await expect(manager.setTitle('conv-del-meta', 'Ghost Title')).rejects.toThrow(/deleted|does not exist/);
        await expect(manager.updateSummary('conv-del-meta', { messageCount: 1, preview: 'p' }))
            .rejects.toThrow(/deleted|does not exist/);
        await expect(manager.setCustomMetadata('conv-del-meta', 'k', 'v'))
            .rejects.toThrow(/deleted|does not exist/);

        // meta 未复活
        expect(await adapter.loadMetadata('conv-del-meta')).toBeNull();
    });

    test('删除后 getMessagesPaged 读取返回空页且不重建会话（含悬空工具调用的规范化写回被短路）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-paged-del', 'PagedDel');
        await manager.addContent('conv-paged-del', makeContent('user', 'before'));
        // 悬空 functionCall：正常读取时 getMessagesPaged 首屏会触发规范化写回（插入 rejected FR）
        await manager.addContent('conv-paged-del', {
            role: 'model',
            parts: [{ functionCall: { id: 'call_paged1', name: 'read_file', args: { path: 'a.txt' } } }]
        } as Content);

        await manager.deleteConversation('conv-paged-del');

        // 删除短路：分页读取返回空页，且不写回（不复活历史目录）
        const page = await manager.getMessagesPaged('conv-paged-del');
        expect(page.total).toBe(0);
        expect(page.messages).toHaveLength(0);

        // 历史/目录/meta 均未复活
        const result = await adapter.loadHistoryWithStatus('conv-paged-del');
        expect(result.value).toBeNull();
        const convDirs = [...fake.dirs].filter(d => d.endsWith('/conv-paged-del'));
        expect(convDirs).toHaveLength(0);
        expect(await adapter.loadMetadata('conv-paged-del')).toBeNull();
    });

    test('getMessagesPaged 规范化写回与 delete 并发：会话写锁串行，删除后无幽灵历史（R2 3.2）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-paged-race', 'PagedRace');
        await manager.addContent('conv-paged-race', makeContent('user', 'one'));
        // 悬空 functionCall：getMessagesPaged 首屏将触发 normalizeHistoryForDisplay 的写回
        await manager.addContent('conv-paged-race', {
            role: 'model',
            parts: [{ functionCall: { id: 'call_paged2', name: 'read_file', args: { path: 'b.txt' } } }]
        } as Content);

        // 挂起规范化写回的 saveHistory：模拟「读取已完成、写回在途」窗口。
        // 旧实现 delete 不入会话写锁，会滑入该窗口先删后写 → 历史目录被重新创建（幽灵）。
        let releaseSave: () => void = () => {};
        let saveStartedResolve: () => void = () => {};
        const saveStarted = new Promise<void>(r => { saveStartedResolve = r; });
        const originalSave = adapter.saveHistory.bind(adapter);
        (adapter as any).saveHistory = async (id: string, contents: Content[]) => {
            saveStartedResolve();
            await new Promise<void>(r => { releaseSave = r; });
            await originalSave(id, contents);
        };

        const pagedPromise = manager.getMessagesPaged('conv-paged-race');
        await saveStarted; // 规范化写回已进入 storage 写（挂起在会话写锁任务内）
        const deletePromise = manager.deleteConversation('conv-paged-race');
        // delete 必须等待在途规范化写回完成（会话写锁串行），而不是先删后写复活
        releaseSave();
        await Promise.all([pagedPromise, deletePromise]);

        // 会话被删除：无幽灵历史/目录/meta
        const result = await adapter.loadHistoryWithStatus('conv-paged-race');
        expect(result.value).toBeNull();
        const convDirs = [...fake.dirs].filter(d => d.endsWith('/conv-paged-race'));
        expect(convDirs).toHaveLength(0);
        expect(await adapter.loadMetadata('conv-paged-race')).toBeNull();
    });
});
