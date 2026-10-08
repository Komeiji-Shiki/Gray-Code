import type { RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { conversationTools } from '../../../apps/server/src/conversations/tools';
import { fixture, metadata } from './fixtures';

test('后缀追加与交付记录原子提交，冲突回滚并保留历史原文', async () => {
  const f = await fixture();
  try {
    await f.store.createConversation(metadata('append-atomic'));
    const original = { id: 'old', role: 'user', parts: [{ text: '原始正文' }], unknownFuture: { kept: true } };
    await f.store.appendHistory('append-atomic', [original]);
    await f.store.putRecord({ namespace: 'pending', id: 'new', value: { text: '待交付' } });
    const before = (await f.store.getConversationInfo('append-atomic'))!;
    const mutation = { conversationId: 'append-atomic', expectedRevision: before.historyRevision, expectedMetadataToken: before.metadataToken,
      appendMessages: [{ id: 'new', role: 'user', parentId: 'old', parts: [{ text: '新增正文' }] }],
      records: [{ namespace: 'pending', id: 'new', expectedRevision: 99, delete: true as const }] };
    await expect(f.store.commitConversation(mutation)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await f.store.getConversationInfo('append-atomic')).toEqual(before);
    expect((await f.store.readFullHistory('append-atomic')).messages).toEqual([original]);
    expect(await f.store.getRecord('pending', 'new')).toEqual({ text: '待交付' });
    await expect(f.store.commitConversation({ ...mutation, messages: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.store.commitConversation({ ...mutation, messageUpdates: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    mutation.records[0].expectedRevision = 1;
    const result = await f.store.commitConversation(mutation);
    expect(result.total).toBe(2);
    expect((await f.store.readFullHistory('append-atomic')).messages).toEqual([original, mutation.appendMessages[0]]);
    expect(await f.store.getRecord('pending', 'new')).toBeNull();
    await expect(f.store.commitConversation(mutation)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  } finally { await f.cleanup(); }
});

test('待办和活动工具跳过历史正文，元数据并发变更仍拒绝覆盖', async () => {
  const f = await fixture();
  try {
    await f.store.createConversation(metadata('tool-metadata'));
    await f.store.appendHistory('tool-metadata', [{ id: 'original', role: 'user', parts: [{ text: '原始历史保留' }] }]);
    const run: RunRecord = { id: 'tool-run', requestKey: 'tool-request', conversationId: 'tool-metadata', actorId: 'owner', agentId: 'default',
      catalogVersion: 'fixture', iteration: 0, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
    await f.store.commitConversation({ conversationId: run.conversationId, expectedRevision: 1, startRun: { run } });
    const app = { storage: f.store, conversation: async (_actor: string, id: string) => f.store.getConversation(id),
      productUi: { conversations: { clearMetadataCache: jest.fn() } }, publish: jest.fn(),
      activity: { stats: async () => ({ generatedAt: Date.now(), today: null, currentSession: { active: false, startedAt: null, minutes: 0 },
        daily: [], hourlyHeatmap: [], monthly: [] }) },
    } as unknown as PlatformApplication;
    const tools = new Map(conversationTools(app).map(tool => [tool.declaration.name, tool]));
    const context: ToolContext = { runId: run.id, conversationId: run.conversationId, actorId: 'owner',
      signal: new AbortController().signal, progress: () => {}, askUser: jest.fn() };
    const full = jest.spyOn(f.store, 'readConversationState'), selected = jest.spyOn(f.store, 'readHistorySelection');
    const info = jest.spyOn(f.store, 'getConversationInfo');
    expect(await tools.get('todo_write')!.execute({ todos: [{ id: 'first', content: '第一步', status: 'pending' }] }, context)).toMatchObject({ success: true });
    expect(await tools.get('todo_update')!.execute({ ops: [{ op: 'set_status', id: 'first', status: 'completed' }] }, context)).toMatchObject({ success: true });
    expect(info).toHaveBeenCalledTimes(2);
    expect(await tools.get('get_activity_stats')!.execute({}, context)).toMatchObject({ success: true });
    expect(info).toHaveBeenCalledTimes(2); expect(full).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled();
    expect((await f.store.getConversation(run.conversationId))?.custom).toMatchObject({ unknownFutureField: '保留',
      todoList: [{ id: 'first', content: '第一步', status: 'completed' }] });
    const commit = f.store.commitConversation.bind(f.store);
    jest.spyOn(f.store, 'commitConversation').mockImplementationOnce(async value => {
      const current = (await f.store.getConversation(run.conversationId))!;
      await f.store.saveMetadata({ ...current, title: '并发修改标题' });
      return commit(value);
    });
    await expect(tools.get('todo_update')!.execute({ ops: [{ op: 'set_content', id: 'first', content: '过期修改' }] }, context))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await f.store.getConversation(run.conversationId)).toMatchObject({ title: '并发修改标题',
      custom: { todoList: [{ content: '第一步' }] } });
  } finally { jest.restoreAllMocks(); await f.cleanup(); }
});

test('conversation transaction rolls back history, metadata, snapshots, records and run reservation together', async () => {
  const f = await fixture();
  try {
    await f.store.createConversation(metadata('atomic'));
    await f.store.appendHistory('atomic', [{ id: 'user', role: 'user', parts: [{ text: 'original' }] }]);
    await f.store.putRecord({ namespace: 'branches', id: 'atomic', ownerId: 'atomic', value: { selected: 'old' } });
    const before = await f.store.readConversationState('atomic', [{ namespace: 'branches', id: 'atomic' }]);
    const run: RunRecord = { id: 'new-run', requestKey: 'once', conversationId: 'atomic', actorId: 'owner', agentId: 'default',
      catalogVersion: 'fixture', iteration: 0, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
    const mutation = { conversationId: 'atomic', expectedRevision: before.history.revision, expectedMetadataToken: before.metadataToken,
      metadata: { ...before.metadata, title: 'changed' }, messages: [],
      snapshot: { id: 'before-edit', conversationId: 'atomic', timestamp: Date.now() }, startRun: { run },
      records: [{ namespace: 'branches', id: 'atomic', value: { selected: 'new' }, expectedRevision: 999 }] };
    await expect(f.store.commitConversation(mutation)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await f.store.getRun(run.id)).toBeNull();
    expect(await f.store.listSnapshots('atomic')).toEqual([]);
    expect(await f.store.readConversationState('atomic', [{ namespace: 'branches', id: 'atomic' }])).toEqual(before);
    mutation.records[0].expectedRevision = before.records[0].record.revision!;
    const committed = await f.store.commitConversation(mutation);
    expect(committed.run?.created).toBe(true);
    expect((await f.store.getSnapshot('before-edit'))?.history[0].parts[0].text).toBe('original');
    const duplicate = await f.store.commitConversation(mutation);
    expect(duplicate.run?.created).toBe(false); expect(duplicate.revision).toBe(committed.revision);
    await expect(f.store.commitConversation({ conversationId: 'atomic', expectedRevision: committed.revision,
      messages: [{ role: 'user', parts: [{ text: 'must not overwrite a running task' }] }] })).rejects.toMatchObject({ code: 'STORAGE_BUSY' });
    await f.store.appendRunEvent({ runId: run.id, type: 'run.interrupted', payload: {}, update: { status: 'interrupted' } });
    const fresh = await f.store.readConversationState('atomic');
    await f.store.saveMetadata({ ...fresh.metadata, title: 'concurrent rename' });
    await expect(f.store.commitConversation({ conversationId: 'atomic', expectedRevision: fresh.history.revision,
      expectedMetadataToken: fresh.metadataToken, metadata: { ...fresh.metadata, title: 'stale rename' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await f.store.verify()).ok).toBe(true);
  } finally { await f.cleanup(); }
});
