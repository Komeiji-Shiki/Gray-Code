import { randomBytes } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import type { BackupMergeGroup, BackupUnit, LongMemoryRecordInput, LongMemoryScope } from '@graycode/contracts';
import { fixture, message, metadata } from './fixtures';

function group(source: BackupUnit[], current: BackupUnit[], selected: (unit: BackupUnit) => boolean, conflict: 'keep' | 'replace' = 'replace'): BackupMergeGroup {
  const units = source.filter(selected);
  return { id: 'selection', units, conflict, source: Object.fromEntries(units.map(unit => [unit.key, unit.fingerprint])),
    expected: Object.fromEntries(units.map(unit => [unit.key, current.find(row => row.key === unit.key)?.fingerprint ?? null])) };
}

async function markSearchIndexPending(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.close();
  const db = new Database(path.join(f.data, 'platform.sqlite'));
  try {
    // 模拟旧库尚未补建的索引，正文和历史版本保持不变。
    db.exec('DELETE FROM history_search; UPDATE histories SET search_revision=-1,search_position=0;');
  } finally { db.close(); }
  f.store = await PlatformStorage.open(f.data);
}

describe('选择性恢复的真实 SQLite 合并', () => {
  let source: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { source = await fixture(); target = await fixture(); });
  afterEach(async () => { await source.cleanup(); await target.cleanup(); });

  test('恢复已索引会话后正文仍可搜索，消息位置准确且后续追加保持索引', async () => {
    await source.store.createConversation(metadata('searchable'));
    await source.store.appendHistory('searchable', [message(0, '备份里的星图坐标'), message(1, '备份里的后续说明')]);
    await target.store.createConversation(metadata('searchable'));
    await target.store.appendHistory('searchable', [message(0, '替换前的旧正文')]);
    expect((await source.store.searchConversationIds('星图坐标')).matches).toHaveLength(1);
    const selection = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.kind === 'conversation');
    const snapshot = await source.store.backupSnapshot();
    await target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] });
    expect(await target.store.searchConversationIds('星图坐标')).toEqual({ indexing: false,
      matches: [{ id: 'searchable', messageIndex: 0, messageId: 'message_0', excerpt: '备份里的星图坐标' }] });
    expect((await target.store.searchConversationIds('替换前的旧正文')).matches).toEqual([]);
    await target.store.appendHistory('searchable', [message(2, '恢复后的新消息')]);
    expect((await target.store.searchConversationIds('新消息')).matches[0]).toMatchObject({ id: 'searchable', messageIndex: 2 });
    expect((await target.store.searchConversationIds('星图坐标')).matches).toHaveLength(1);
  });

  test('补建正文索引不使恢复预览过期，真实历史修改仍拒绝旧预览', async () => {
    await source.store.createConversation(metadata('alpha'));
    await source.store.appendHistory('alpha', [message(0, '备份正文')]);
    await target.store.createConversation(metadata('alpha'));
    await target.store.appendHistory('alpha', Array.from({ length: 600 }, (_, index) => message(index, '待补建索引 ' + index)));
    await markSearchIndexPending(target);
    const inventory = await target.store.backupInventory();
    const selection = group(await source.store.backupInventory(), inventory, unit => unit.kind === 'conversation');
    const snapshot = await source.store.backupSnapshot();
    expect((await target.store.searchConversationIds('待补建索引')).indexing).toBe(true);
    expect(await target.store.backupInventory()).toEqual(inventory);
    await expect(target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] })).resolves.toMatchObject({ restored: [expect.any(String)] });
    const next = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.kind === 'conversation');
    await target.store.appendHistory('alpha', [message(1, '确认前继续输入')]);
    await expect(target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [next] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  test('恢复部分索引时保留已索引前缀，并从原进度继续补建', async () => {
    await source.store.createConversation(metadata('partial'));
    await source.store.appendHistory('partial', Array.from({ length: 1100 }, (_, index) => message(index,
      index === 0 ? '已索引前缀标识' : index === 1099 ? '尚未索引末尾标识' : '中间消息 ' + index)));
    await markSearchIndexPending(source);
    expect((await source.store.searchConversationIds('已索引前缀标识')).indexing).toBe(true);
    const selection = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.kind === 'conversation');
    const snapshot = await source.store.backupSnapshot();
    await target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] });
    const prefix = await target.store.searchConversationIds('已索引前缀标识');
    expect(prefix.indexing).toBe(true);
    expect(prefix.matches[0]).toMatchObject({ id: 'partial', messageIndex: 0 });
    const tail = await target.store.searchConversationIds('尚未索引末尾标识');
    expect(tail.indexing).toBe(false);
    expect(tail.matches[0]).toMatchObject({ id: 'partial', messageIndex: 1099 });
  });

  test('未选会话向共享段追加消息不会使所选前缀的恢复预览过期', async () => {
    await source.store.createConversation(metadata('prefix'));
    await source.store.appendHistory('prefix', [message(0, '备份中的前缀会话')]);
    await target.store.createConversation(metadata('original'));
    await target.store.appendHistory('original', [message(0, '原会话共享前缀')]);
    await target.store.forkConversation('original', metadata('prefix'), { beforeIndex: 1 });
    const selection = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.id === 'prefix');
    const snapshot = await source.store.backupSnapshot();
    await target.store.appendHistory('original', [message(1, '未选会话继续输入')]);
    expect((await target.store.readHistory('prefix')).messages).toHaveLength(1);
    await expect(target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] })).resolves.toMatchObject({ restored: [expect.any(String)] });
    expect((await target.store.readHistory('prefix')).messages[0].parts[0].text).toBe('备份中的前缀会话');
    expect((await target.store.readHistory('original')).messages[1].parts[0].text).toBe('未选会话继续输入');
  });

  test('重映射共享历史与附件，保留未选择会话，恢复运行事件和归属记录', async () => {
    const bytes = randomBytes(1_200_000);
    await source.store.createConversation(metadata('alpha'));
    await source.store.appendHistory('alpha', [{ ...message(0), parts: [{ inlineData: { mimeType: 'application/octet-stream', data: bytes.toString('base64') } }] }]);
    await source.store.saveSnapshot({ id: 'alpha-snapshot', conversationId: 'alpha', timestamp: Date.now() });
    const now = Date.now(); await source.store.createRun({ id: 'alpha-run', requestKey: 'alpha-request', conversationId: 'alpha', actorId: 'owner', agentId: 'default', status: 'queued', createdAt: now, updatedAt: now, iteration: 0, catalogVersion: 'fixture' }, message(1, '来源任务'));
    await source.store.appendRunEvent({ runId: 'alpha-run', type: 'run.started', payload: {}, update: { status: 'running' } });
    await source.store.appendRunEvent({ runId: 'alpha-run', type: 'run.completed', payload: {}, update: { status: 'completed' } });
    await source.store.putRecord({ namespace: 'automations', id: 'alpha-task', ownerId: 'alpha', value: { progress: '来源进度' } });
    await source.store.putRecord({ namespace: 'pet-resource-file', id: 'unselected/model.bin', value: { bytes: new Uint8Array(randomBytes(1_300_000)) } });
    await target.store.createConversation(metadata('alpha')); await target.store.appendHistory('alpha', [message(0, '当前版本')]);
    await target.store.createConversation(metadata('beta')); await target.store.appendHistory('beta', [message(0, '应保留的当前会话')]);
    await target.store.saveSnapshot({ id: 'beta-snapshot', conversationId: 'beta', timestamp: now });
    const selection = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.kind === 'conversation');
    const snapshot = await source.store.backupSnapshot();
    const result = await target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] });
    expect(result.restored).toHaveLength(1);
    expect((await target.store.readHistory('alpha')).messages[0].parts[0]).toMatchObject({ inlineData: { data: bytes.toString('base64') } });
    expect((await target.store.getSnapshot('alpha-snapshot'))?.history).toHaveLength(1);
    expect((await target.store.getSnapshot('beta-snapshot'))?.history[0].parts[0].text).toBe('应保留的当前会话');
    expect((await target.store.getRun('alpha-run'))?.status).toBe('completed');
    expect((await target.store.readRunEvents('alpha-run')).at(-1)?.type).toBe('run.completed');
    expect(await target.store.getRecord('automations', 'alpha-task')).toEqual({ progress: '来源进度' });
    expect(await target.store.getRecord('pet-resource-file', 'unselected/model.bin')).toBeNull();
    await target.store.collectGarbage(); expect((await target.store.verify()).ok).toBe(true);
  });

  test('同组资源保留当前版本，替换时拒绝预览之后的新修改', async () => {
    await source.store.putRecord({ namespace: 'pet-resource', id: 'model', value: { name: '备份模型' } });
    await source.store.putRecord({ namespace: 'pet-resource-file', id: 'model/texture', value: { bytes: new Uint8Array([1, 2, 3]) } });
    await target.store.putRecord({ namespace: 'pet-resource', id: 'model', value: { name: '当前模型' } });
    const sourceUnits = await source.store.backupInventory(), targetUnits = await target.store.backupInventory();
    const snapshot = await source.store.backupSnapshot();
    const kept = await target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [group(sourceUnits, targetUnits, () => true, 'keep')] });
    expect(kept.kept).toHaveLength(2); expect(await target.store.getRecord('pet-resource-file', 'model/texture')).toBeNull();
    const replacing = group(sourceUnits, targetUnits, () => true);
    await target.store.putRecord({ namespace: 'pet-resource', id: 'model', value: { name: '预览后继续修改' } });
    await expect(target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [replacing] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await target.store.getRecord('pet-resource', 'model')).toEqual({ name: '预览后继续修改' });
  });

  test('记忆范围保留修订、来源、摘要依赖、向量与全文检索，重新分配整数行号', async () => {
    const legacy = { id: 'legacy-memory', actorId: 'owner' }, now = Date.now();
    await source.store.memoryWrite({ scope: legacy, expectedRevision: 0, mutation: { type: 'append', entries: [{ date: '2026-09-14', text: '旧格式记忆' }] }, source: { label: '原始写入来源' } });
    const scope: LongMemoryScope = { id: 'restored-memory', actorId: 'owner', kind: 'personal', realm: 'real' };
    const record = (id: string, extra: Partial<LongMemoryRecordInput> = {}): LongMemoryRecordInput => ({ id, text: '隔离项目使用端口 4808。', kind: 'project', origin: 'user', confidence: 'confirmed', subject: '隔离项目', topic: ['项目'], entities: [], expectedVersion: 0, recordedAt: now, validFrom: now, dependencies: [{ kind: 'source', id: 'port-source', version: 1 }], supersedes: [], ...extra });
    await source.store.longMemoryWrite({ scope, sources: [{ id: 'port-source', text: '隔离项目使用端口 4808。', origin: 'user', expectedVersion: 0, recordedAt: now }], records: [record('port', { vector: { model: 'test-vector', dimensions: 2, values: [1, 0] } })] });
    await source.store.longMemoryWrite({ scope, records: [record('summary', { kind: 'summary', dependencies: [{ kind: 'record', id: 'port', version: 1 }] })] });
    const otherScope = { ...scope, id: 'keep-memory' };
    await target.store.longMemoryWrite({ scope: otherScope, sources: [{ id: 'port-source', text: '保留原范围', origin: 'user', expectedVersion: 0, recordedAt: now }], records: [record('kept', { text: '保留原范围' })] });
    const selection = group(await source.store.backupInventory(), await target.store.backupInventory(), unit => unit.kind === 'memory' || unit.kind === 'long-memory');
    const snapshot = await source.store.backupSnapshot(); await target.store.mergeBackupUnits({ sourceDirectory: snapshot.directory, groups: [selection] });
    expect((await target.store.memoryRevisions(legacy))[0].source).toEqual({ label: '原始写入来源' });
    expect((await target.store.memoryEntries(legacy, 0, 10))[0].text).toBe('旧格式记忆');
    const recalled = await target.store.longMemoryRecall({ scopes: [scope], text: '端口 4808', asOf: now + 1, knownAt: now + 1, limit: 10, tokenBudget: 2000, vector: { model: 'test-vector', dimensions: 2, values: [1, 0] } });
    expect(recalled.hits.some(hit => hit.record.id === 'port')).toBe(true);
    expect((await target.store.longMemoryExport([otherScope])).records[0].text).toBe('保留原范围');
    expect((await target.store.longMemoryExport([scope])).records.find(row => row.id === 'summary')?.dependencies).toEqual([{ kind: 'record', id: 'port', version: 1 }]);
    expect((await target.store.verify()).ok).toBe(true);
  });
});
