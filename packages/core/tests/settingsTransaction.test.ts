import { fixture } from './fixtures';

describe('atomic settings drafts', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('saves multiple settings sections together and rejects a stale draft without partial changes', async () => {
    const initial = await f.store.commitRecords([
      { namespace: 'settings', id: 'appearance', expectedRevision: null, value: { color: '#555555' } },
      { namespace: 'settings', id: 'agents', expectedRevision: null, value: ['first'] },
    ]);
    expect(initial.map(record => record.revision)).toEqual([1, 1]);
    await f.store.putRecord({ namespace: 'settings', id: 'agents', value: ['other client'] });
    await expect(f.store.commitRecords([
      { namespace: 'settings', id: 'appearance', expectedRevision: 1, value: { color: '#ffffff' } },
      { namespace: 'settings', id: 'agents', expectedRevision: 1, value: ['stale'] },
    ])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await f.store.getVersionedRecord('settings', 'appearance')).toEqual({ value: { color: '#555555' }, revision: 1 });
    expect(await f.store.getVersionedRecord('settings', 'agents')).toEqual({ value: ['other client'], revision: 2 });
    await f.store.collectGarbage();
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('rolls back all settings when a later value cannot be encoded', async () => {
    await expect(f.store.commitRecords([
      { namespace: 'settings', id: 'first', value: { valid: true } },
      { namespace: 'settings', id: 'second', value: { unsupported: Infinity } },
    ])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await f.store.getVersionedRecord('settings', 'first')).toEqual({ value: null, revision: null });
  });
});
