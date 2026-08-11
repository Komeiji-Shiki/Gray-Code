/**
 * HIS 追加路径 / 元数据合并写入 / 批量摘要 / 完整性检查 测试。
 *
 * 覆盖：
 * - addContent 纯追加（非 functionResponse）走 storage.appendHistory，不再走全量 saveHistory；
 * - addContent functionResponse 保留配对去重语义（mutate 全量写回）；
 * - addBatch 走 append-only；
 * - deleteMessage / 编辑等结构性变更仍走全量重写；
 * - 用量索引增量维护（appendUsage 命中/回退全量重建/仅追加 user 不写盘）；
 * - updateSummary 一次 loadMetadata+saveMetadata 合并写入（HIS-09）；
 * - getConversationMetadataBatch 一次批量摘要（HIS-10）；
 * - getMetadata 完整性检查只读 index，不解析末段消息（HIS-11）。
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { UsageIndex, UsageIndexStore } from '../../modules/conversation/usageStats';
import type { Content } from '../../modules/conversation';
import { createAdapter } from './helpers/fakeVscodeFs';
import { makeContent } from '../__fixtures__/conversationFixtures';

describe('ConversationManager 会话创建并发', () => {
    test('同一 ID 的并发首次创建合并执行，不误报“对话已存在”', async () => {
        const storage = new MemoryStorageAdapter();
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);

        await expect(Promise.all([
            manager.createConversation('conv-create-race', 'First'),
            manager.createConversation('conv-create-race', 'Second'),
            manager.getHistory('conv-create-race'),
        ])).resolves.toBeDefined();

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(await manager.getHistory('conv-create-race')).toEqual([]);
    });

    test('创建完成后的显式重复创建仍然报错', async () => {
        const manager = new ConversationManager(new MemoryStorageAdapter());
        await manager.createConversation('conv-existing', 'First');

        await expect(manager.createConversation('conv-existing', 'Second'))
            .rejects.toThrow(/已存在|already exists/i);
    });

    test('并发去重：首个未带绑定、第二个带绑定时补绑，用户侧绑定不丢失', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const wsUri = 'file:///c%3A/Users/foo/ProjectA';

        await expect(Promise.all([
            // H4 自动建会话（无绑定 hint）
            manager.createConversation('conv-create-bind', 'H4'),
            // 用户建会话（带当前工作区绑定），与 H4 并发去重合并
            manager.createConversation('conv-create-bind', 'User', wsUri),
        ])).resolves.toBeDefined();

        const meta = await manager.getMetadata('conv-create-bind');
        expect(meta?.workspaceUri).toBe(wsUri);
    });

    test('并发去重：首个已带绑定时，第二个绑定不覆盖（绑定即终身）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);

        await expect(Promise.all([
            manager.createConversation('conv-create-bind2', 'User', 'file:///c%3A/Users/foo/ProjectA'),
            manager.createConversation('conv-create-bind2', 'H4', 'file:///c%3A/Users/foo/ProjectB'),
        ])).resolves.toBeDefined();

        const meta = await manager.getMetadata('conv-create-bind2');
        expect(meta?.workspaceUri).toBe('file:///c%3A/Users/foo/ProjectA');
    });
});

describe('ConversationManager 追加路径（HIS-01/HIS-02）', () => {
    test('addContent 纯追加走 appendHistory，不再全量 saveHistory', async () => {
        const storage = new MemoryStorageAdapter();
        const appendSpy = jest.spyOn(storage, 'appendHistory');
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-append', 'Append');
        appendSpy.mockClear();
        saveSpy.mockClear();

        const persisted = await manager.addContent('conv-append', makeContent('user', 'hello'));

        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).not.toHaveBeenCalled();
        expect(persisted).toMatchObject({
            role: 'user',
            parentId: null,
            parts: [{ text: 'hello' }]
        });
        expect(typeof persisted?.id).toBe('string');
        expect(persisted?.id).not.toHaveLength(0);
        const history = await manager.getHistory('conv-append');
        expect(history).toHaveLength(1);
        expect(history[0].id).toBe(persisted?.id);
        expect(history[0].parts[0]).toEqual({ text: 'hello' });
    });

    test('addMessage / addBatch 也走 append-only', async () => {
        const storage = new MemoryStorageAdapter();
        const appendSpy = jest.spyOn(storage, 'appendHistory');
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-batch', 'Batch');
        appendSpy.mockClear();
        saveSpy.mockClear();

        await manager.addMessage('conv-batch', 'user', [{ text: 'm1' }]);
        await manager.addBatch('conv-batch', [makeContent('model', 'r1'), makeContent('user', 'm2')]);

        expect(appendSpy).toHaveBeenCalledTimes(2);
        expect(saveSpy).not.toHaveBeenCalled();
        const history = await manager.getHistory('conv-batch');
        expect(history).toHaveLength(3);
    });

    test('addMessage 携带 messageId 时原样落库（BR-01：窗口 id 与后端 id 对齐）', async () => {
        const manager = new ConversationManager(new MemoryStorageAdapter());
        await manager.createConversation('conv-mid', 'MID');

        // 前端发送时携带窗口 user 消息 id → 后端原样保存，编辑/重试才能按 id 定位
        await manager.addMessage('conv-mid', 'user', [{ text: 'm1' }], undefined, 'window_id_123');

        let history = await manager.getHistory('conv-mid');
        expect(history).toHaveLength(1);
        expect(history[0].id).toBe('window_id_123');
        expect(history[0].parentId).toBeNull();

        // 不传 messageId 时由后端生成稳定 id（兼容旧客户端 / 后端内部调用）
        await manager.addMessage('conv-mid', 'user', [{ text: 'm2' }]);
        history = await manager.getHistory('conv-mid');
        expect(history).toHaveLength(2);
        expect(typeof history[1].id).toBe('string');
        expect(history[1].id).not.toHaveLength(0);
        expect(history[1].id).not.toBe('window_id_123');
        // 线性 parentId 链保持正确
        expect(history[1].parentId).toBe('window_id_123');
    });

    test('addContent functionResponse 保留配对去重语义（mutate 全量写回，重复响应被去重）', async () => {
        const storage = new MemoryStorageAdapter();
        const appendSpy = jest.spyOn(storage, 'appendHistory');
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-fr', 'FR');
        appendSpy.mockClear();
        saveSpy.mockClear();

        // functionCall（纯追加）
        await manager.addContent('conv-fr', makeContent('model', '', {
            parts: [{ functionCall: { id: 'tool-1', name: 'read_file', args: '{}' } }]
        }));
        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).not.toHaveBeenCalled();

        // functionResponse（mutate 路径，走 saveHistory）
        const frContent = makeContent('user', '', {
            isFunctionResponse: true,
            parts: [{ functionResponse: { id: 'tool-1', name: 'read_file', response: { success: true } } }]
        });
        await manager.addContent('conv-fr', frContent);
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalledTimes(1); // 仍只有 functionCall 走 append

        // 再次提交同一响应：去重，历史不新增
        await manager.addContent('conv-fr', frContent);
        const history = await manager.getHistory('conv-fr');
        const frCount = history.filter(m => m.isFunctionResponse).length;
        expect(frCount).toBe(1);
    });

    test('删除/编辑/回档/分支切换仍走全量重写（saveHistory）', async () => {
        const storage = new MemoryStorageAdapter();
        const appendSpy = jest.spyOn(storage, 'appendHistory');
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-mut', 'Mut');
        await manager.addBatch('conv-mut', [makeContent('user', 'a'), makeContent('model', 'b'), makeContent('user', 'c')]);
        appendSpy.mockClear();
        saveSpy.mockClear();

        await manager.deleteMessage('conv-mut', 1);
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).not.toHaveBeenCalled();

        appendSpy.mockClear();
        saveSpy.mockClear();
        await manager.updateMessage('conv-mut', 1, { parts: [{ text: 'edited' }] });
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).not.toHaveBeenCalled();
    });

    test('L4：addBatch 拒绝 functionResponse（无去重安全网，契约显式禁止）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-fr-batch', 'FRBatch');

        const frContent = makeContent('user', '', {
            isFunctionResponse: true,
            parts: [{ functionResponse: { id: 'tool-1', name: 'read_file', response: { success: true } } }]
        });
        await expect(manager.addBatch('conv-fr-batch', [makeContent('user', 'ok'), frContent]))
            .rejects.toThrow(/does not support functionResponse/);

        // 拒绝后历史不变（append 未发生）
        const history = await manager.getHistory('conv-fr-batch');
        expect(history).toHaveLength(0);
    });

    test('无 appendHistory 的适配器回退全量读改写（语义不变）', async () => {
        const storage = new MemoryStorageAdapter();
        // 模拟旧适配器：删掉 appendHistory
        const original = storage.appendHistory.bind(storage);
        (storage as any).appendHistory = undefined;
        const saveSpy = jest.spyOn(storage, 'saveHistory');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-fallback', 'FB');

        await manager.addContent('conv-fallback', makeContent('user', 'x'));
        expect(saveSpy).toHaveBeenCalled();
        const history = await manager.getHistory('conv-fallback');
        expect(history).toHaveLength(1);

        (storage as any).appendHistory = original;
    });
});

describe('用量索引增量维护（HIS-08）', () => {
    function makeStore(): {
        store: UsageIndexStore;
        writes: Array<{ id: string; index: UsageIndex }>;
        appends: Array<{ id: string; count: number }>;
    } {
        const writes: Array<{ id: string; index: UsageIndex }> = [];
        const appends: Array<{ id: string; count: number }> = [];
        const store: UsageIndexStore = {
            async read() { return writes.length ? writes[writes.length - 1].index : null; },
            async write(conversationId, index) { writes.push({ id: conversationId, index }); },
            async remove() {},
            async getFreshness() { return 'fresh'; },
            async appendUsage(conversationId, appended) {
                appends.push({ id: conversationId, count: appended.length });
                const current = await store.read!(conversationId);
                if (!current) return false;
                const added = appended.filter(m => m.role === 'model').length;
                for (let i = 0; i < added; i++) {
                    current.messages.push({ prompt: 1, candidates: 1, thoughts: 0, cacheCreation: 0, cacheRead: 0 });
                }
                return true;
            }
        };
        return { store, writes, appends };
    }

    test('追加 model 消息走增量 appendUsage；追加 user 消息不重复写盘', async () => {
        const storage = new MemoryStorageAdapter();
        const { store, writes, appends } = makeStore();
        const manager = new ConversationManager(storage, store);
        await manager.createConversation('conv-usage-inc', 'Usage');

        // 第一次追加 model（含用量）：索引尚不存在，appendUsage 返回 false → 全量重建建立索引
        await manager.addContent('conv-usage-inc', makeContent('model', 'first', {
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } as Content['usageMetadata']
        }));
        expect(appends).toHaveLength(1);
        expect(writes.length).toBeGreaterThan(0);
        const writesAfterFirst = writes.length;

        // 仅追加 user 消息：增量返回 true（无新条目），不触发全量 write
        await manager.addContent('conv-usage-inc', makeContent('user', 'hi'));
        expect(appends).toHaveLength(2);
        expect(writes.length).toBe(writesAfterFirst);

        // 再次追加 model：增量更新条目，不触发全量重建（write 仍不被调用）
        await manager.addContent('conv-usage-inc', makeContent('model', 'reply', {
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80 } as Content['usageMetadata']
        }));
        expect(appends).toHaveLength(3);
        expect(writes.length).toBe(writesAfterFirst);
        // 最后一次全量重建的索引（内存中被增量修改后）包含全部 2 条 model 条目
        expect(writes[writes.length - 1].index.messages).toHaveLength(2);
    });

    test('appendUsage 返回 false（索引缺失/损坏）时回退全量重建', async () => {
        const storage = new MemoryStorageAdapter();
        const { store, writes, appends } = makeStore();
        (store as any).appendUsage = async () => false;
        const manager = new ConversationManager(storage, store);
        await manager.createConversation('conv-usage-fb', 'UsageFB');

        await manager.addContent('conv-usage-fb', makeContent('model', 'reply', {
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } as Content['usageMetadata']
        }));

        // 回退到全量重建：write 被调用
        expect(writes.length).toBeGreaterThan(0);
        expect(appends).toHaveLength(0);
    });

    test('无 appendUsage 的 store 回退全量重建', async () => {
        const storage = new MemoryStorageAdapter();
        const writes: Array<{ id: string; index: UsageIndex }> = [];
        const store: UsageIndexStore = {
            async read() { return null; },
            async write(conversationId, index) { writes.push({ id: conversationId, index }); },
            async remove() {},
            async getFreshness() { return 'missing'; }
        };
        const manager = new ConversationManager(storage, store);
        await manager.createConversation('conv-usage-legacy', 'UsageLegacy');

        await manager.addContent('conv-usage-legacy', makeContent('model', 'reply', {
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } as Content['usageMetadata']
        }));

        expect(writes.length).toBeGreaterThan(0);
        expect(writes[writes.length - 1].index.messages).toHaveLength(1);
    });
});

describe('updateSummary 合并写入（HIS-09）', () => {
    test('一次 loadMetadata+saveMetadata 写入 messageCount/preview', async () => {
        const storage = new MemoryStorageAdapter();
        const saveMetaSpy = jest.spyOn(storage, 'saveMetadata');
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-summary', 'Summary');

        saveMetaSpy.mockClear();
        await manager.updateSummary('conv-summary', { messageCount: 42, preview: 'hello preview' });

        // 只写了一次 metadata
        expect(saveMetaSpy).toHaveBeenCalledTimes(1);
        const meta = await storage.loadMetadata('conv-summary');
        expect(meta!.custom!.messageCount).toBe(42);
        expect(meta!.custom!.preview).toBe('hello preview');
        expect(meta!.updatedAt).toBeGreaterThan(0);
    });

    test('只传 preview 不清除已有 messageCount', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-summary2', 'Summary2');
        await manager.updateSummary('conv-summary2', { messageCount: 7 });

        await manager.updateSummary('conv-summary2', { preview: 'new preview' });

        const meta = await storage.loadMetadata('conv-summary2');
        expect(meta!.custom!.messageCount).toBe(7);
        expect(meta!.custom!.preview).toBe('new preview');
    });

    test('M3：messageCount 超过实际历史提交数时钳制到 index.totalMessages（append 失败后乐观计数不永久超前）', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-clamp', 'Clamp');
        await manager.addBatch('conv-clamp', [
            makeContent('user', 'a'), makeContent('model', 'b'), makeContent('user', 'c')
        ]);

        // 前端乐观更新传 100（实际历史只有 3 条）→ 钳制为 3
        await manager.updateSummary('conv-clamp', { messageCount: 100 });
        let meta = await adapter.loadMetadata('conv-clamp');
        expect(meta!.custom!.messageCount).toBe(3);

        // 合法值（<= totalMessages）不受影响
        await manager.updateSummary('conv-clamp', { messageCount: 2 });
        meta = await adapter.loadMetadata('conv-clamp');
        expect(meta!.custom!.messageCount).toBe(2);

        // 不传 messageCount 不清除已有值
        await manager.updateSummary('conv-clamp', { preview: 'p' });
        meta = await adapter.loadMetadata('conv-clamp');
        expect(meta!.custom!.messageCount).toBe(2);
    });
});

describe('getConversationMetadataBatch（HIS-10）', () => {
    test('一次批量返回一页摘要（title/createdAt/updatedAt/messageCount/preview）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-b1', 'Batch One');
        await manager.updateSummary('conv-b1', { messageCount: 12, preview: 'first preview' });
        await manager.createConversation('conv-b2', 'Batch Two');
        await manager.updateSummary('conv-b2', { messageCount: 3 });

        const summaries = await manager.getConversationMetadataBatch(['conv-b1', 'conv-b2', 'conv-missing']);

        expect(summaries).toHaveLength(3);
        expect(summaries[0].id).toBe('conv-b1');
        expect(summaries[0].title).toBe('Batch One');
        expect(summaries[0].messageCount).toBe(12);
        expect(summaries[0].preview).toBe('first preview');
        expect(summaries[1].messageCount).toBe(3);
        expect(summaries[2].id).toBe('conv-missing');
        expect(summaries[2].title).toContain('Chat');
    });

    test('空数组直接返回 []', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        expect(await manager.getConversationMetadataBatch([])).toEqual([]);
    });

    test('M6：超过 200 个 ID 时截断到 200（防批量 IPC 过大）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const ids = Array.from({ length: 250 }, (_, i) => `conv-batch-${i}`);
        const summaries = await manager.getConversationMetadataBatch(ids);
        expect(summaries).toHaveLength(200);
        expect(summaries[0].id).toBe('conv-batch-0');
        expect(summaries[199].id).toBe('conv-batch-199');
    });
});

describe('getMetadataLight 元数据缓存（PERF）', () => {
    test('缓存命中时不读盘（对话列表分页/统计热路径）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-light', 'Light');
        await manager.addBatch('conv-light', [makeContent('user', 'a'), makeContent('model', 'b')]);
        await manager.updateSummary('conv-light', { messageCount: 5, preview: 'p' });

        fake.readCalls.length = 0;
        const meta = await manager.getMetadataLight('conv-light');
        expect(meta).not.toBeNull();
        expect(meta!.title).toBe('Light');
        // M3 钳制：messageCount 不超过实际历史数（2 条）
        expect(meta!.custom!.messageCount).toBe(2);
        // 写路径已回填 metaCache：全程无磁盘读取
        expect(fake.readCalls).toHaveLength(0);
    });

    test('返回深拷贝，调用方修改不污染缓存', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-copy', 'Copy');

        const first = await manager.getMetadataLight('conv-copy');
        first!.custom = { polluted: true };

        fake.readCalls.length = 0;
        const second = await manager.getMetadataLight('conv-copy');
        expect(second!.custom).not.toHaveProperty('polluted');
        expect(fake.readCalls).toHaveLength(0);
    });

    test('not_found 负缓存命中不读盘；创建对话后由写路径覆盖', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);

        fake.readCalls.length = 0;
        expect(await manager.getMetadataLight('conv-nc')).toBeNull();
        expect(fake.readCalls.length).toBeGreaterThan(0); // 首次仍读盘
        const readsAfterMiss = fake.readCalls.length;

        expect(await manager.getMetadataLight('conv-nc')).toBeNull();
        expect(fake.readCalls.length).toBe(readsAfterMiss); // 负缓存命中，不再读盘

        await manager.createConversation('conv-nc', 'NC');
        fake.readCalls.length = 0;
        const meta = await manager.getMetadataLight('conv-nc');
        expect(meta?.title).toBe('NC'); // 写路径覆盖负缓存
        expect(fake.readCalls).toHaveLength(0);
    });

    test('负缓存 null 不遮蔽 getMetadata 的历史重建 fallback（有历史无 meta.json 的会话）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-missing-meta', 'MissingMeta');
        await manager.addBatch('conv-missing-meta', [makeContent('user', 'a'), makeContent('model', 'b')]);

        // 模拟 meta.json 丢失（损坏改名备份 / 手动删除）而历史仍在
        const metaPath = Array.from(fake.files.keys()).find(p => p.endsWith('/conv-missing-meta.meta.json'));
        expect(metaPath).toBeDefined();
        fake.files.delete(metaPath!);

        // 对话列表分页先走 getMetadataLight → 负缓存 null
        expect(await manager.getMetadataLight('conv-missing-meta')).toBeNull();

        // getMetadata 不得被负缓存遮蔽：历史存在时应走磁盘路径重建 fallback
        const meta = await manager.getMetadata('conv-missing-meta');
        expect(meta).not.toBeNull();
        expect(meta!.id).toBe('conv-missing-meta');
        // createFallbackMetadata 默认标题（本地化「对话 <id>」）
        expect(meta!.title).toContain('conv-missing-meta');
        // 重建结果回填缓存：后续 getMetadataLight 直接命中，不再返回 null
        expect(await manager.getMetadataLight('conv-missing-meta')).not.toBeNull();
    });

    test('getMetadata 损坏降级 fallback 回填缓存后 getMetadataLight 不再负缓存 null', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-corrupt-meta', 'CorruptMeta');
        await manager.addBatch('conv-corrupt-meta', [makeContent('user', 'a')]);

        // 直接把 meta.json 写成损坏内容（parse_error 降级路径）
        const metaPath = Array.from(fake.files.keys()).find(p => p.endsWith('/conv-corrupt-meta.meta.json'));
        expect(metaPath).toBeDefined();
        fake.files.set(metaPath!, '{ not valid json');

        const meta = await manager.getMetadata('conv-corrupt-meta');
        expect(meta).not.toBeNull();
        // 降级后回填缓存：getMetadataLight 不再返回 null（标题/时间戳不持续缺失）
        expect(await manager.getMetadataLight('conv-corrupt-meta')).not.toBeNull();
    });
});

describe('getMetadata 完整性检查只读 index（HIS-11）', () => {
    test('不解析末段历史消息（不读 .ndjson）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);

        await manager.createConversation('conv-meta', 'Meta');
        await manager.addBatch('conv-meta', [            makeContent('user', 'a'), makeContent('model', 'b'), makeContent('user', 'c')
        ]);

        fake.readCalls.length = 0;
        const meta = await manager.getMetadata('conv-meta');

        expect(meta).not.toBeNull();
        expect(meta!.title).toBe('Meta');
        expect(meta!.integrityStatus).toBeUndefined();
        // 没有读取任何 .ndjson 段消息
        expect(fake.readCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
        // 只读了 index.json（与 meta.json）
        expect(fake.readCalls.some(p => p.includes('history.index.json'))).toBe(true);
    });

    test('历史缺失时返回 null 且 integrityStatus 为 history_missing（只读 index）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-meta2', 'Meta2');
        // 手动删除 index（模拟历史丢失），保留 meta
        const indexPath = [...fake.files.keys()].find(p => p.includes('history.index.json'));
        expect(indexPath).toBeTruthy();
        fake.files.delete(indexPath!);
        // 清元数据缓存：完整性检查必须基于真实磁盘状态（LRU 缓存是 fork 增量）
        manager.clearCaches();

        const meta = await manager.getMetadata('conv-meta2');
        expect(meta).not.toBeNull();
        expect(meta!.integrityStatus).toBe('history_missing');
        expect(fake.readCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
    });
});

describe('getMetadataLight 元数据缓存（PERF）', () => {
    test('缓存命中时不读盘（对话列表分页/统计热路径）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-light', 'Light');
        await manager.addBatch('conv-light', [makeContent('user', 'a'), makeContent('model', 'b')]);
        await manager.updateSummary('conv-light', { messageCount: 5, preview: 'p' });

        fake.readCalls.length = 0;
        const meta = await manager.getMetadataLight('conv-light');
        expect(meta).not.toBeNull();
        expect(meta!.title).toBe('Light');
        // M3 钳制：messageCount 不超过实际历史数量（2 条）
        expect(meta!.custom!.messageCount).toBe(2);
        // 写路径已回填 metaCache：全程无磁盘读取
        expect(fake.readCalls).toHaveLength(0);
    });

    test('返回深拷贝，调用方修改不污染缓存', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-copy', 'Copy');

        const first = await manager.getMetadataLight('conv-copy');
        first!.custom = { polluted: true };

        fake.readCalls.length = 0;
        const second = await manager.getMetadataLight('conv-copy');
        expect(second!.custom).not.toHaveProperty('polluted');
        expect(fake.readCalls).toHaveLength(0);
    });

    test('not_found 负缓存命中不读盘；创建对话后由写路径覆盖', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);

        fake.readCalls.length = 0;
        expect(await manager.getMetadataLight('conv-nc')).toBeNull();
        expect(fake.readCalls.length).toBeGreaterThan(0); // 首次仍读盘
        const readsAfterMiss = fake.readCalls.length;

        expect(await manager.getMetadataLight('conv-nc')).toBeNull();
        expect(fake.readCalls.length).toBe(readsAfterMiss); // 负缓存命中，不再读盘

        await manager.createConversation('conv-nc', 'NC');
        fake.readCalls.length = 0;
        const meta = await manager.getMetadataLight('conv-nc');
        expect(meta?.title).toBe('NC'); // 写路径覆盖负缓存
        expect(fake.readCalls).toHaveLength(0);
    });

    test('标题/自定义元数据写路径回填缓存，无需重新读盘', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-write', 'W');

        await manager.setTitle('conv-write', 'Renamed');
        await manager.setCustomMetadata('conv-write', 'key', 42);
        fake.readCalls.length = 0;

        const meta = await manager.getMetadataLight('conv-write');
        expect(meta!.title).toBe('Renamed');
        expect(meta!.custom!.key).toBe(42);
        expect(fake.readCalls).toHaveLength(0);
    });

    test('历史追加（appendHistory 刷新 updatedAt）后缓存失效，重新读盘', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-append', 'Append');

        fake.readCalls.length = 0;
        await manager.getMetadataLight('conv-append'); // 缓存回填

        await manager.addContent('conv-append', makeContent('user', 'x'));
        const readsAfterAppend = fake.readCalls.length;

        const meta = await manager.getMetadataLight('conv-append');
        expect(meta).not.toBeNull();
        // append 路径已失效缓存：本次读取必须重新走磁盘
        expect(fake.readCalls.length).toBeGreaterThan(readsAfterAppend);
    });

    test('删除会话后缓存失效，不再返回已删除会话的快照', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-del', 'Del');

        fake.readCalls.length = 0;
        expect(await manager.getMetadataLight('conv-del')).not.toBeNull(); // 缓存回填

        await manager.deleteConversation('conv-del');
        fake.readCalls.length = 0;
        expect(await manager.getMetadataLight('conv-del')).toBeNull();
        // 删除路径已失效缓存：本次读取重新走磁盘并得到 not_found
        expect(fake.readCalls.length).toBeGreaterThan(0);
    });
});
