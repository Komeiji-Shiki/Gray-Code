import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import { fixture, metadata } from './fixtures';
import { SCHEMA_VERSION } from '../src/storage/schema';

function snapshot() {
  const image = randomBytes(90_000).toString('base64');
  const tool = { name: 'fixture', description: randomBytes(3000).toString('hex'), inputSchema: { type: 'object' } };
  return { protocol: 'fixture', body: { tools: [tool], messages: [
    { role: 'user', content: randomBytes(6000).toString('hex') },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + image } }] },
    { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: image } }], signature: '\ud800 exactly\r\n' },
  ] }, prefix: { tools: [tool] } };
}

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
