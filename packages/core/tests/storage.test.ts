import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import { fixture, message, metadata } from './fixtures';
import { SCHEMA_VERSION } from '../src/storage/schema';

describe('independent SQLite storage worker', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('persists typed history, lossless signatures and deduplicated binary attachments across reopen', async () => {
    await f.store.createConversation(metadata('alpha'));
    const image = randomBytes(80_000).toString('base64');
    const content = { ...message(0), parts: [
      { text: '中文与 emoji 🐱\r\n'.repeat(8000), thought: true, thoughtSignatures: { signature: '  exact\nopaque-signature  ' } },
      { inlineData: { mimeType: 'image/png', data: image } },
      { inlineData: { mimeType: 'image/png', data: image } },
    ], extra: { future: [1, null, true] } };
    const first = await f.store.appendHistory('alpha', [content], { expectedRevision: 0 });
    expect(first).toEqual({ revision: 1, total: 1 });
    expect((await f.store.readHistory('alpha')).messages).toEqual([content]);
    const stats = await f.store.statistics();
    expect(stats.sqliteVersion.split('.').map(Number)[1]).toBeGreaterThanOrEqual(51);
    expect(stats.storedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(content)) / 2);
    await f.store.close();
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.readHistory('alpha')).messages).toEqual([content]);
    expect((await f.store.verify()).ok).toBe(true);
    await f.store.close();
  });

  test('paginates by index and lists by stable workspace cursor', async () => {
    for (const id of ['a', 'b', 'c']) await f.store.createConversation({ ...metadata(id), workspaceUri: 'file:///project' });
    await f.store.appendHistory('a', Array.from({ length: 310 }, (_, index) => message(index)));
    const tail = await f.store.readHistory('a', { limit: 15 });
    expect(tail.startIndex).toBe(295);
    expect(tail.messages.map(item => item.id)).toEqual(Array.from({ length: 15 }, (_, index) => `message_${index + 295}`));
    expect((await f.store.readHistory('a', { beforeIndex: 130, limit: 8 })).messages).toEqual(Array.from({ length: 8 }, (_, index) => message(index + 122)));
    expect((await f.store.readHistory('a', { offset: 307, limit: 20 })).messages).toHaveLength(3);
    const one = await f.store.listConversations({ workspaceUri: 'file:///project', limit: 2 });
    const two = await f.store.listConversations({ workspaceUri: 'file:///project', limit: 2, cursor: one.nextCursor });
    expect(new Set([...one.items, ...two.items].map(item => item.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  test('rejects stale writes and rolls an invalid batch back atomically', async () => {
    await f.store.createConversation(metadata('a'));
    await f.store.appendHistory('a', [message(1)]);
    const before = await f.store.statistics();
    await expect(f.store.replaceHistory('a', [], { expectedRevision: 0 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(f.store.appendHistory('a', [message(2), { role: 'user', parts: [], invalid: Infinity }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await f.store.readHistory('a')).messages).toEqual([message(1)]);
    const after = await f.store.statistics();
    expect(after.objects).toBe(before.objects);
    expect(after.storedBytes).toBe(before.storedBytes);
  });

  test('forks share old content while append, replace, deletion and collection remain isolated', async () => {
    await f.store.createConversation(metadata('source'));
    const original = Array.from({ length: 150 }, (_, index) => message(index, `original ${index} ${'content '.repeat(200)}`));
    await f.store.appendHistory('source', original);
    const before = await f.store.statistics();
    await f.store.forkConversation('source', metadata('fork'), { beforeIndex: 140, expectedRevision: 1 });
    const forked = await f.store.statistics();
    expect(forked.storedBytes - before.storedBytes).toBeLessThan(1024);
    await f.store.appendHistory('source', [message(150, 'source only')]);
    await f.store.appendHistory('fork', [message(151, 'fork only')]);
    await f.store.replaceHistory('source', [original[0], message(999, 'replacement')]);
    expect((await f.store.readHistory('fork', { limit: 1000 })).messages).toEqual([...original.slice(0, 140), message(151, 'fork only')]);
    await f.store.deleteConversation('source');
    await f.store.collectGarbage();
    expect((await f.store.readHistory('fork', { limit: 1000 })).messages).toEqual([...original.slice(0, 140), message(151, 'fork only')]);
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('records share content and follow owner deletion without corrupting other records', async () => {
    await f.store.createConversation(metadata('a'));
    const value = { text: 'shared-record'.repeat(10000) };
    await f.store.putRecord({ namespace: 'snapshot', id: 'one', ownerId: 'a', value });
    await f.store.putRecord({ namespace: 'snapshot', id: 'two', ownerId: 'b', value });
    expect(await f.store.listRecords('snapshot', 'a')).toEqual(['one']);
    await f.store.deleteConversation('a');
    await f.store.collectGarbage();
    expect(await f.store.getRecord('snapshot', 'one')).toBeNull();
    expect(await f.store.getRecord('snapshot', 'two')).toEqual(value);
  });

  test('detects corrupted external content instead of returning an empty attachment', async () => {
    await f.store.createConversation(metadata('a'));
    const binary = randomBytes(1_200_000).toString('base64');
    await f.store.appendHistory('a', [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/octet-stream', data: binary } }] }]);
    const shards = await fs.readdir(path.join(f.data, 'objects'));
    const shard = path.join(f.data, 'objects', shards[0]);
    const files = await fs.readdir(shard);
    await fs.writeFile(path.join(shard, files[0]), 'corrupt');
    await expect(f.store.readHistory('a')).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
    expect((await f.store.verify()).ok).toBe(false);
  });

  test('prevents concurrent owners and rejects calls after close', async () => {
    await expect(PlatformStorage.open(f.data)).rejects.toMatchObject({ code: 'STORAGE_BUSY' });
    await Promise.all([f.store.close(), f.store.close()]);
    await expect(f.store.statistics()).rejects.toMatchObject({ code: 'STORAGE_CLOSED' });
  });

  test('preserves unusual JSON keys and UTF-16 code units instead of corrupting legacy text', async () => {
    const unusual = JSON.parse('{"__proto__":{"notExecutable":true},"constructor":"ordinary data"}');
    await f.store.putRecord({ namespace: 'codec', id: 'unusual', value: { unusual, text: '\ud800 unpaired \udfff', empty: [], data: [undefined] } });
    expect(await f.store.getRecord('codec', 'unusual')).toEqual({ unusual, text: '\ud800 unpaired \udfff', empty: [], data: [null] });
    expect(({} as Record<string, unknown>).notExecutable).toBeUndefined();
  });

  test('native snapshots share their prefix and remain intact after current history changes', async () => {
    await f.store.createConversation(metadata('a'));
    await f.store.appendHistory('a', Array.from({ length: 130 }, (_, i) => message(i)));
    await f.store.saveSnapshot({ id: 'snap', conversationId: 'a', timestamp: 123 });
    await f.store.replaceHistory('a', []);
    await f.store.collectGarbage();
    expect((await f.store.getSnapshot('snap'))?.history).toHaveLength(130);
    expect((await f.store.readHistory('a')).total).toBe(0);
    await f.store.deleteSnapshot('snap');
    await f.store.collectGarbage();
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('upgrades the first platform schema without changing existing history', async () => {
    await f.store.createConversation(metadata('existing'));
    await f.store.appendHistory('existing', [message(1)]);
    await f.store.close();
    const database = new Database(path.join(f.data, 'platform.sqlite'));
    // 还原一代数据库时同时移除后续加入的记忆表，避免把新结构伪装成旧版本。
    database.exec(`DROP TABLE memory_revision_summaries; DROP TABLE memory_revision_entries; DROP TABLE memory_revisions;
      DROP TABLE memory_summaries; DROP TABLE memory_entries; DROP TABLE memory_scopes;
      DROP TABLE run_events; DROP TABLE runs; ALTER TABLE records DROP COLUMN revision; PRAGMA user_version=1`);
    database.close();
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.statistics()).schemaVersion).toBe(SCHEMA_VERSION);
    expect((await f.store.readHistory('existing')).messages).toEqual([message(1)]);
    expect(await f.store.listRuns()).toEqual([]);
  });
});
