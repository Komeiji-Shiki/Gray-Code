import { ConversationManager } from '../../../backend/modules/conversation/ConversationManager';
import { SqliteStorageAdapter } from '../../../backend/modules/conversation/SqliteStorageAdapter';
import { fixture } from './fixtures';

describe('existing conversation manager on the independent storage service', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('creates atomically, appends real messages, restores a snapshot and deletes the conversation', async () => {
    const adapter = new SqliteStorageAdapter(f.store);
    const manager = new ConversationManager(adapter);
    await manager.createConversation('integration', '独立存储', 'file:///workspace');
    await manager.addMessage('integration', 'user', [{ text: 'hello' }], undefined, 'user_1');
    await manager.addMessage('integration', 'model', [{ text: 'world' }], undefined, 'model_1');
    const history = await manager.getHistory('integration');
    expect(history.map(item => item.id)).toEqual(['user_1', 'model_1']);
    expect(history[1].parentId).toBe('user_1');
    const snapshot = await manager.createSnapshot('integration', 'before next message');
    await manager.addMessage('integration', 'user', [{ text: 'later' }], undefined, 'user_2');
    await manager.restoreSnapshot('integration', snapshot.id);
    expect((await manager.getHistory('integration')).map(item => item.id)).toEqual(['user_1', 'model_1']);
    expect((await adapter.loadHistoryPage('integration', { beforeIndex: 0 })).value?.messages).toEqual([]);
    expect(await adapter.getHistoryTotalMessages('integration')).toBe(2);
    expect((await adapter.loadMetadata('integration'))?.title).toBe('独立存储');
    await manager.deleteConversation('integration');
    await f.store.collectGarbage();
    expect(await adapter.listConversations()).toEqual([]);
    expect(await adapter.loadSnapshot(snapshot.id)).toBeNull();
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('核心直接写入或替换历史后，旧界面摘要读取实际消息数', async () => {
    const adapter = new SqliteStorageAdapter(f.store);
    const manager = new ConversationManager(adapter);
    await manager.createConversation('direct-core', '准确条数', 'file:///fixture');
    const original = (await f.store.getConversation('direct-core'))!;
    await f.store.appendHistory('direct-core', [{ id: 'pending-user', role: 'user', parts: [{ text: '尚未收到回复的请求' }] }]);
    manager.clearMetadataCache();
    expect((await manager.getMetadata('direct-core'))?.custom?.messageCount).toBe(1);
    expect((await manager.getConversationMetadataBatch(['direct-core']))[0].messageCount).toBe(1);
    expect((await adapter.loadMetadata('direct-core'))?.title).toBe('准确条数');
    // 摘要投影不会改写原始元数据中的历史字段。
    expect((await f.store.getConversation('direct-core'))?.custom).toEqual(original.custom);
    await f.store.replaceHistory('direct-core', []);
    expect((await adapter.loadMetadata('direct-core'))?.custom?.messageCount).toBe(0);
    expect(await adapter.loadMetadata('does-not-exist')).toBeNull();
  });

  test('persists subagent transcripts and projections through the existing adapter contract', async () => {
    const adapter = new SqliteStorageAdapter(f.store);
    const manager = new ConversationManager(adapter);
    await manager.createConversation('transcripts');
    const transcript = { contents: [{ role: 'model' as const, parts: [{ text: 'child result' }] }],
      lastSentHistoryProjection: { version: 1 as const, entries: [{ contentIndex: 0 }] } };
    await adapter.saveSubAgentTranscript('transcripts', 'child:1', transcript);
    expect(await adapter.loadSubAgentTranscript('transcripts', 'child:1')).toEqual(transcript);
    await adapter.deleteSubAgentTranscript('transcripts', 'child:1');
    expect(await adapter.loadSubAgentTranscript('transcripts', 'child:1')).toBeNull();
  });
});
