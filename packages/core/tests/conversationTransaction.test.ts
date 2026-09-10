import type { RunRecord } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

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
