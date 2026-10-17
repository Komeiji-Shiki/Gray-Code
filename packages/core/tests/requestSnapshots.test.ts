import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import { fixture, metadata } from './fixtures';
import { SCHEMA_VERSION } from '../src/storage/schema';
import { PlatformDatabase } from '../src/storage/database';
import { ObjectStore } from '../src/storage/objects';

function snapshot() {
  const image = randomBytes(90_000).toString('base64');
  const tool = { name: 'fixture', description: randomBytes(3000).toString('hex'), inputSchema: { type: 'object' } };
  return { protocol: 'fixture', body: { tools: [tool], messages: [
    { role: 'user', content: randomBytes(6000).toString('hex') },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + image } }] },
    { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: image } }], signature: '\ud800 exactly\r\n' },
  ] }, prefix: { tools: [tool] } };
}

test('请求条目按 Worker 私有输入复用，调用方编辑、回滚与回收不能留下错误引用', async () => {
  const f = await fixture();
  await f.store.close();
  // 直接执行当前编码与记录处理源码，不让旧 worker 产物代替本次缓存实现。
  const database = new PlatformDatabase(f.data);
  const writes = jest.spyOn(ObjectStore.prototype, 'put');
  const value = { ...snapshot(), iteration: 1 };
  const save = (id: string, current: unknown = value) => database.execute('putRecord', {
    // 此直连端口也产生独立入站 DTO，保持真实 postMessage 的所有权边界。
    namespace: 'model-requests', id, ownerId: 'owner', value: JSON.parse(JSON.stringify(current)),
  });
  try {
    save('first');
    writes.mockClear();
    save('second', { ...value, iteration: 2 });
    // 未变的消息、工具和附件直接挂接已有值引用，只编码新的请求根对象。
    expect(writes).toHaveBeenCalledTimes(1);
    const originalText = value.body.messages[0]!.content;
    value.body.messages[0]!.content = '同一对象的正文已修改';
    writes.mockClear();
    save('edited');
    expect(writes.mock.calls.length).toBeGreaterThan(1);
    expect((database.execute('getRecord', { namespace: 'model-requests', id: 'first' }) as typeof value)
      .body.messages[0]!.content).toEqual(originalText);
    expect(database.execute('getRecord', { namespace: 'model-requests', id: 'edited' })).toEqual(value);
    const projected = database.execute('getVersionedRecord', { namespace: 'model-requests', id: 'edited', projection: {
      fields: ['body'], properties: { body: { fields: ['messages'] } }, omitBinary: true,
    } }).value as typeof value;
    expect(projected.body.messages[2]!.parts![0]!.inlineData.data).toBe('');
    expect(projected.body.messages[2]!.signature).toBe('\ud800 exactly\r\n');
    expect(projected.body.messages[0]!.content).toBe('同一对象的正文已修改');

    const changed = { ...value, body: { ...value.body, messages: [{ role: 'user', content: '仅存在于回滚事务中的消息' }] } };
    const cyclic: { messages: unknown[] } = { messages: [] };
    cyclic.messages.push(cyclic);
    expect(() => database.execute('commitRecords', [
      { namespace: 'model-requests', id: 'rolled-back', ownerId: 'owner', value: changed },
      { namespace: 'model-requests', id: 'cycle', ownerId: 'owner', value: cyclic },
    ])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(database.execute('getRecord', { namespace: 'model-requests', id: 'rolled-back' })).toBeNull();
    save('after-rollback', changed);
    expect(database.execute('getRecord', { namespace: 'model-requests', id: 'after-rollback' })).toEqual(changed);

    for (const id of ['first', 'second', 'edited', 'after-rollback']) database.execute('deleteRecord', { namespace: 'model-requests', id });
    database.execute('collectGarbage', undefined);
    expect(database.execute('statistics', undefined).objects).toBe(0);
    save('after-gc');
    expect(database.execute('getRecord', { namespace: 'model-requests', id: 'after-gc' })).toEqual(value);
    expect(database.execute('verify', undefined).ok).toBe(true);
    database.execute('deleteRecord', { namespace: 'model-requests', id: 'after-gc' });
    database.execute('collectGarbage', undefined);
    expect(database.execute('statistics', undefined).objects).toBe(0);
  } finally { writes.mockRestore(); database.execute('close', undefined); await f.cleanup(); }
});

test('请求大于缓存容量时顺序读取仍复用已有条目', async () => {
  const f = await fixture();
  await f.store.close();
  const database = new PlatformDatabase(f.data);
  const writes = jest.spyOn(ObjectStore.prototype, 'put');
  const value = { body: { messages: Array.from({ length: 3000 }, (_, index) => ({ role: 'user', content: `长会话消息 ${index}` })) } };
  const save = (id: string) => database.execute('putRecord', { namespace: 'model-requests', id, ownerId: 'owner', value });
  try {
    save('first');
    const firstWrites = writes.mock.calls.length;
    writes.mockClear();
    save('second');
    expect(writes.mock.calls.length).toBeLessThan(firstWrites / 2);
    expect(database.execute('getRecord', { namespace: 'model-requests', id: 'second' })).toEqual(value);
  } finally { writes.mockRestore(); database.execute('close', undefined); await f.cleanup(); }
});

test('请求消息和图片共享存储，在重启、删除回收与选择性恢复后完整还原', async () => {
  const f = await fixture(), value = snapshot();
  let target: PlatformStorage | undefined;
  try {
    await f.store.createConversation(metadata('a')); await f.store.createConversation(metadata('b'));
    await f.store.putRecord({ namespace: 'model-requests', id: 'a:1', ownerId: 'a', value: { ...value, iteration: 1 } });
    const before = await f.store.statistics();
    await f.store.putRecord({ namespace: 'model-requests', id: 'b:2', ownerId: 'b', value: { ...value, iteration: 2 } });
    expect((await f.store.statistics()).storedBytes - before.storedBytes).toBeLessThan(2048);
    await f.store.close(); f.store = await PlatformStorage.open(f.data);
    expect(await f.store.getRecord('model-requests', 'a:1')).toEqual({ ...value, iteration: 1 });
    const units = await f.store.backupInventory(), unit = units.find(item => item.kind === 'conversation' && item.id === 'b')!;
    const backup = await f.store.backupSnapshot();
    await f.store.deleteConversation('a'); await f.store.collectGarbage();
    expect(await f.store.getRecord('model-requests', 'b:2')).toEqual({ ...value, iteration: 2 });
    target = await PlatformStorage.open(path.join(f.root, 'restore-target'));
    await target.mergeBackupUnits({ sourceDirectory: backup.directory, groups: [{ id: 'selected-conversation', conflict: 'replace',
      units: [{ kind: 'conversation', id: 'b' }], source: { [unit.key]: unit.fingerprint }, expected: { [unit.key]: null } }] });
    await target.collectGarbage();
    expect(await target.getConversation('a')).toBeNull();
    expect(await target.getRecord('model-requests', 'b:2')).toEqual({ ...value, iteration: 2 });
    expect((await target.verify()).ok).toBe(true);
    await f.store.deleteConversation('b'); await f.store.collectGarbage();
    expect((await f.store.statistics()).objects).toBe(0);
  } finally { await target?.close(); await f.cleanup(); }
});

test('旧格式请求保持可读，新格式遇到循环引用时整批回滚', async () => {
  const f = await fixture(), value = snapshot();
  try {
    await f.store.createConversation(metadata('legacy'));
    // 普通记录仍使用第 6 版的编码，构造未分离消息的旧请求记录。
    await f.store.putRecord({ namespace: 'legacy-format', id: 'request', ownerId: 'legacy', value });
    await f.store.close();
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    db.prepare("UPDATE records SET namespace='model-requests' WHERE namespace='legacy-format'").run();
    // 旧版没有正文索引和实体关联标记，样本结构须与版本号一致。
    db.exec(`DROP TRIGGER history_search_ai; DROP TRIGGER history_search_ad;
      DROP TABLE history_search_fts; DROP TABLE history_search; DROP INDEX entries_by_body;
      ALTER TABLE histories DROP COLUMN search_revision; ALTER TABLE histories DROP COLUMN search_position;
      ALTER TABLE long_memory_dependencies DROP COLUMN association;`);
    db.pragma('user_version = 6'); db.close();
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.statistics()).schemaVersion).toBe(SCHEMA_VERSION);
    expect(await f.store.getRecord('model-requests', 'request')).toEqual(value);
    const previous = await f.store.statistics();
    const cyclic: { messages: unknown[] } = { messages: [] }; cyclic.messages.push(cyclic);
    await expect(f.store.commitRecords([
      { namespace: 'model-requests', id: 'new', value }, { namespace: 'model-requests', id: 'cycle', value: cyclic },
    ])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await f.store.getRecord('model-requests', 'new')).toBeNull();
    expect((await f.store.statistics()).objects).toBe(previous.objects);
  } finally { await f.cleanup(); }
});
