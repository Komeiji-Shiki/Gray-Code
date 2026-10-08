import type { RunRecord } from '@graycode/contracts';
import { PlatformStorage, type ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { conversationTools } from '../../../apps/server/src/conversations/tools';
import { SubagentFeedback } from '../../../apps/server/src/subagents/feedback';
import { BackgroundContinuation } from '../../../apps/server/src/subagents/continuation';
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

test('交付积压分批提交，后续冲突重试保留先前进度和父节点顺序', async () => {
  const f = await fixture();
  try {
    const id = 'feedback-batches';
    await f.store.createConversation(metadata(id));
    await f.store.appendHistory(id, [{ id: 'original', role: 'user', parts: [{ text: '原有消息' }] }]);
    const pending = Array.from({ length: 130 }, (_, index) => {
      const messageId = `feedback-${String(130 - index).padStart(3, '0')}`;
      return { id: messageId, conversationId: id, actorId: 'owner', sequence: index + 1, displayOnly: index > 0,
        message: { id: messageId, role: 'user', timestamp: 42, parts: [{ text: messageId }] } };
    });
    await f.store.commitRecords(pending.map(value => ({ namespace: 'subagent-feedback', id: value.id, ownerId: id, value })));
    const app = { storage: f.store, subagents: { isChildConversation: () => false },
      productUi: { conversations: { clearMetadataCache: jest.fn() } }, publish: jest.fn() } as unknown as PlatformApplication;
    const feedback = new SubagentFeedback(app);
    const commit = f.store.commitConversation.bind(f.store);
    let attempts = 0;
    const writes = jest.spyOn(f.store, 'commitConversation').mockImplementation(async value => {
      if (++attempts === 2) await f.store.saveMetadata({ ...(await f.store.getConversation(id))!, title: '交付期间的并发标题' });
      return commit(value);
    });
    expect(await feedback.flush(id)).toBe(true);
    expect(writes.mock.calls.length).toBeGreaterThan(2);
    expect(writes.mock.calls.every(([value]) => value.records!.length <= 256)).toBe(true);
    const history = (await f.store.readFullHistory(id)).messages;
    expect(history.map(message => message.id)).toEqual(['original', ...pending.map(value => value.id)]);
    expect(history.slice(1).map(message => message.parentId)).toEqual(history.slice(0, -1).map(message => message.id));
    expect(await feedback.pendingIds(id)).toEqual([]);
    expect(await f.store.listRecords('subagent-deliveries', id)).toHaveLength(130);
    expect(await f.store.listRecords('background-followups', id)).toEqual([pending[0].id]);
    expect((await f.store.getConversation(id))?.title).toBe('交付期间的并发标题');
    expect(await feedback.flush(id)).toBe(false);
  } finally { jest.restoreAllMocks(); await f.cleanup(); }
});

test('续跑消费分批中断后恢复认领进度，不重发已经认领的模型任务', async () => {
  const f = await fixture();
  try {
    const id = 'followup-recovery';
    await f.store.createConversation(metadata(id));
    const pending = Array.from({ length: 130 }, (_, index) => ({ id: `result-${String(index).padStart(3, '0')}`,
      conversationId: id, actorId: 'owner', status: 'pending', createdAt: index,
      parentConfiguration: { agentId: 'fixture', configuration: { providerId: 'fixture' } } }));
    await f.store.appendHistory(id, pending.slice(0, -1).map(value => ({ id: value.id, role: 'user', parts: [{ text: value.id }] })));
    for (let offset = 0; offset < pending.length; offset += 100) await f.store.commitRecords(pending.slice(offset, offset + 100).flatMap(value => [
      { namespace: 'background-followups', id: value.id, ownerId: id, value },
      { namespace: 'background-followup-pending', id: value.id, ownerId: id, value: { id: value.id } },
    ]));
    const run: RunRecord = { id: 'reserved-run', requestKey: 'already-reserved', conversationId: id, actorId: 'owner', agentId: 'fixture',
      catalogVersion: 'fixture', iteration: 0, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
    await f.store.commitConversation({ conversationId: id, expectedRevision: 1, startRun: { run } });
    const app = { storage: f.store, runtime: { continue: jest.fn(async () => { throw new Error('不得重复发起模型'); }) }, publish: jest.fn() } as unknown as PlatformApplication;
    const continuation = new BackgroundContinuation(app);
    const full = jest.spyOn(f.store, 'readConversationState');
    const commit = f.store.commitRecords.bind(f.store);
    let batches = 0;
    const writes = jest.spyOn(f.store, 'commitRecords').mockImplementation(async records => {
      if (++batches === 2) throw new Error('模拟第二批写入中断');
      return commit(records);
    });
    await expect(continuation.consume(run)).rejects.toThrow('模拟第二批写入中断');
    expect(full).not.toHaveBeenCalled();
    expect(writes.mock.calls.every(([records]) => records.length <= 256)).toBe(true);
    expect(await f.store.getRecord('background-followup-claims', id)).toMatchObject({ completed: 127 });
    expect(await f.store.listRecords('background-followup-pending', id)).toHaveLength(3);
    await continuation.close();
    jest.restoreAllMocks(); await f.store.close();
    f.store = await PlatformStorage.open(f.data);
    await f.store.appendRunEvent({ runId: run.id, type: 'run.interrupted', payload: {}, update: { status: 'interrupted' } });
    const recovered = new BackgroundContinuation({ storage: f.store, runtime: app.runtime, publish: app.publish } as PlatformApplication);
    await recovered.initialize(); await recovered.close();
    expect(app.runtime.continue).not.toHaveBeenCalled();
    expect(await f.store.getRecord('background-followup-claims', id)).toBeNull();
    expect(await f.store.listRecords('background-followup-pending', id)).toEqual([]);
    expect(await f.store.getRecord('background-followups', pending[0].id)).toMatchObject({ status: 'delivered', runId: run.id });
    expect(await f.store.getRecord('background-followups', pending.at(-2)!.id)).toMatchObject({ status: 'delivered', runId: run.id });
    expect(await f.store.getRecord('background-followups', pending.at(-1)!.id)).toMatchObject({ status: 'obsolete', runId: run.id });
  } finally { jest.restoreAllMocks(); await f.cleanup(); }
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
