import { randomBytes } from 'node:crypto';
import { PlatformStorage } from '@graycode/core';
import type { BackupMergeGroup, BackupUnit, LongMemoryRecordInput, LongMemoryScope } from '@graycode/contracts';
import { fixture, message, metadata } from './fixtures';

function group(source: BackupUnit[], current: BackupUnit[], selected: (unit: BackupUnit) => boolean, conflict: 'keep' | 'replace' = 'replace'): BackupMergeGroup {
  const units = source.filter(selected);
  return { id: 'selection', units, conflict, source: Object.fromEntries(units.map(unit => [unit.key, unit.fingerprint])),
    expected: Object.fromEntries(units.map(unit => [unit.key, current.find(row => row.key === unit.key)?.fingerprint ?? null])) };
}

describe('选择性恢复的真实 SQLite 合并', () => {
  let source: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { source = await fixture(); target = await fixture(); });
  afterEach(async () => { await source.cleanup(); await target.cleanup(); });

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
