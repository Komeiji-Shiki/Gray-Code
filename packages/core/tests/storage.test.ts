import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { encode } from '@msgpack/msgpack';
import { PlatformStorage } from '@graycode/core';
import { fixture, message, metadata } from './fixtures';
import { openDatabase, SCHEMA_VERSION } from '../src/storage/schema';
import { ObjectStore } from '../src/storage/objects';
import { restoreCharacterTurn, storeCharacterTurn } from '../../../apps/server/src/characters/snapshot';
import type { CharacterTurn } from '../../../apps/server/src/characters/pipeline';

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

  test('角色回合值引用兼容旧历史、备份恢复和垃圾回收', async () => {
    const text = '森林中今天下着小雨。';
    const entry = { id: 'before', content: text, keys: ['森林'], secondaryKeys: [], enabled: true, constant: true,
      selective: false, selectiveLogic: 0, caseSensitive: false, wholeWords: false, useRegex: false,
      order: 0, priority: 0, position: 'before_char', depth: 0, role: 'system' as const, probability: 100,
      preventRecursion: false, excludeRecursion: false };
    const turn: CharacterTurn = {
      config: { kind: 'character', userName: '访客', persona: '', worldbookIds: ['book'], regexIds: [], scanDepth: 2 },
      resources: [{ id: 'book', revision: 1, sha256: 'fixture' }],
      modules: { CHARACTER: '灰魂', WORLDBOOK_BEFORE_CHARACTER: text },
      injections: [{ role: 'system', parts: [{ text }], promptAnchor: { messageId: 'new-user', edge: 'after', order: 0 } }],
      outlets: { weather: text }, macros: { char: '灰魂' }, rules: [], capturedAt: 1, messagePosition: 1,
      activation: { entries: [{ bookId: 'book', entry, text, reason: 'constant' },
        { bookId: 'book', entry: { ...entry, id: 'depth', position: 'at_depth' }, text },
        { bookId: 'book', entry: { ...entry, id: 'outlet', position: 'outlet', outletName: 'weather' }, text }], skipped: [] },
    };
    const snapshot = storeCharacterTurn(turn);
    expect(snapshot.texts).toEqual([text, '灰魂']);
    expect(restoreCharacterTurn(snapshot)).toEqual(turn);
    const originals = [{ ...message(0), id: 'new-user', characterTurn: snapshot },
      { ...message(1), id: 'new-model', characterTurn: snapshot }, { ...message(2), id: 'legacy', characterTurn: turn }];
    await f.store.createConversation(metadata('character'));
    await f.store.appendHistory('character', originals);
    await f.store.close();
    const db = openDatabase(path.join(f.data, 'platform.sqlite'));
    let shared: Buffer[];
    try {
      const objects = new ObjectStore(db, path.join(f.data, 'objects'));
      // 新写入走当前源代码；旧正文直接使用既有 MessagePack 格式，读取仍走正式存储线程。
      for (const content of originals) {
        const hash = content.id === 'legacy' ? objects.put(encode(content, { sortKeys: true })) : objects.putValue(content);
        db.prepare('UPDATE segment_entries SET body_hash=? WHERE message_id=?').run(hash, content.id);
      }
      shared = (db.prepare(`SELECT e.child_hash FROM segment_entries s JOIN object_edges e ON e.parent_hash=s.body_hash
        WHERE s.message_id IN('new-user','new-model') ORDER BY s.message_id`).all() as Array<{ child_hash: Buffer }>).map(row => row.child_hash);
    } finally { db.close(); }
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.readHistory('character')).messages).toEqual(originals);
    await f.store.forkConversation('character', metadata('character-fork'));
    await f.store.deleteConversation('character');
    await f.store.collectGarbage();
    expect((await f.store.readHistory('character-fork')).messages).toEqual(originals);
    const backup = await f.store.backupSnapshot();
    await f.store.deleteConversation('character-fork');
    await f.store.collectGarbage();
    const saved = await PlatformStorage.open(backup.directory);
    try {
      const restored = (await saved.readHistory('character-fork')).messages;
      expect(restored).toEqual(originals);
      expect(restoreCharacterTurn(restored[0].characterTurn)).toEqual(turn);
      expect(restoreCharacterTurn(restored[2].characterTurn)).toEqual(turn);
      expect((await saved.verify()).ok).toBe(true);
    } finally { await saved.close(); }
    expect(shared).toHaveLength(2);
    expect(shared![0].equals(shared![1])).toBe(true);
  });

  test('嵌套字段投影保留数组、共享字典与既有路径统计的语义', async () => {
    const payload = '不用于摘要的正文'.repeat(3000);
    // 超过现有大字典阈值，确保嵌套投影经过共享值引用的读取路径。
    const manifest = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`file-${index}`, { size: index, payload }]));
    const value = { parts: [{ text: payload, functionCall: { id: 'call', name: 'read', args: { payload } } },
      { functionResponse: { id: 'call', response: { success: true, code: 'OK', data: payload } } }],
      manifest, binary: new Uint8Array([1, 2, 3]) };
    // workspace-checkpoints 会启用 shareLargeMaps，让 manifest 以 VALUE_REFERENCE 进入投影路径。
    await f.store.putRecord({ namespace: 'workspace-checkpoints', id: 'nested', value });
    const projected = await f.store.getVersionedRecord('workspace-checkpoints', 'nested', {
      fields: ['parts', 'manifest', 'binary'], omitBinary: true,
      properties: {
        parts: { items: { fields: ['functionCall', 'functionResponse'], properties: {
          functionCall: { fields: ['id'] },
          functionResponse: { fields: ['id', 'response'], properties: { response: { fields: ['code'] } } },
        } } },
        manifest: { values: { fields: ['size'] }, properties: { 'file-0': { fields: ['size', 'payload'],
          properties: { payload: { maxStringLength: 3 } } } } },
      },
      paths: { firstSize: ['manifest', 'file-0', 'size'] },
      mapStats: { manifestStats: { path: ['manifest'], sumFields: ['size'] } },
    });
    expect(projected.value).toEqual({ parts: [{ functionCall: { id: 'call' } },
      { functionResponse: { id: 'call', response: { code: 'OK' } } }], manifest: {
        ...Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`file-${index}`, { size: index }])),
        'file-0': { size: 0, payload: payload.slice(0, 3) },
      },
      binary: new Uint8Array(), firstSize: 0, manifestStats: { count: 130, size: 8385 } });
    expect(await f.store.getRecord('workspace-checkpoints', 'nested')).toEqual(value);
  });

  test('文本前缀投影兼容内联、跨块 UTF-8、孤立代理项和特殊字典键，完整读取保持原文', async () => {
    const texts = Object.fromEntries([
      ['inline', 'A🐱中文'],
      ['inline-large', '中🐱'.repeat(8000)],
      ['utf8', '🐱中文'.repeat(80_000)],
      ['utf16', '\ud800中文🐱'.repeat(60_000)],
      ['__proto__', '特殊字典键'.repeat(10_000)],
      ['constructor', '字典构造属性仍按值投影'],
      ['key\ud800', '键不可被截断'],
    ]);
    await f.store.putRecord({ namespace: 'projection', id: 'text-prefixes', value: texts });
    for (const length of [0, 1, 2, 3, 180, 150_000]) {
      const { value } = await f.store.getVersionedRecord('projection', 'text-prefixes', { values: { maxStringLength: length } });
      expect(value).toEqual(Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, text.slice(0, length)])));
    }
    const overridden = await f.store.getVersionedRecord('projection', 'text-prefixes', {
      values: { maxStringLength: 3 }, properties: { inline: { maxStringLength: 2 } },
    });
    expect(overridden.value).toEqual(Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, text.slice(0, key === 'inline' ? 2 : 3)])));
    expect(await f.store.getRecord('projection', 'text-prefixes')).toEqual(texts);
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
    database.exec(`DROP TABLE long_memory_job_dependencies; DROP TABLE long_memory_jobs;
      DROP TABLE long_memory_dependencies; DROP TABLE long_memory_supersedes; DROP TABLE long_memory_vectors;
      DROP TABLE long_memory_terms; DROP TABLE long_memory_records; DROP TABLE long_memory_sources;
      DROP TABLE long_memory_tombstones; DROP TABLE long_memory_scopes;
      DROP TABLE memory_revision_summaries; DROP TABLE memory_revision_entries; DROP TABLE memory_revisions;
      DROP TABLE memory_summaries; DROP TABLE memory_entries; DROP TABLE memory_scopes;
      DROP TABLE run_events; DROP TABLE runs; ALTER TABLE records DROP COLUMN revision; PRAGMA user_version=1`);
    database.close();
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.statistics()).schemaVersion).toBe(SCHEMA_VERSION);
    expect((await f.store.readHistory('existing')).messages).toEqual([message(1)]);
    expect(await f.store.listRuns()).toEqual([]);
  });
});
