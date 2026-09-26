import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MEMORY_IMPORT_NAMESPACE, type MemoryImportDataset } from '@graycode/contracts';
import { importLifeBook } from '../../../apps/server/src/memory/imports/migrate';
import { importHash, readImportFileChunk, verifyImportFiles } from '../../../apps/server/src/memory/imports/files';
import { importLibraryFiles, listImportLibraries, setImportRecall } from '../../../apps/server/src/memory/imports/library';
import { restoreCatalog, selectBackupRestore } from '../../../apps/server/src/backups/catalog';
import { longMemoryScope, conversationMemoryScopes } from '../../../apps/server/src/memory/longTerm/scopes';
import { fixture } from './fixtures';
import { BOT_CHANNEL_ACCESS } from '../../../apps/server/src/bots/channelAccess';

describe('LifeBook 独立导入资料库', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });
  async function source() {
    await fs.mkdir(path.join(f.source, 'daily'));
    await fs.mkdir(path.join(f.source, 'conversations', '2026-01-01', 'images'), { recursive: true });
    const text = '# 原始日记\r\n' + '完整正文🐱'.repeat(125) + '\n最后一行';
    await fs.writeFile(path.join(f.source, 'daily', 'note.md'), text);
    const image = randomBytes(1_048_700);
    await fs.writeFile(path.join(f.source, 'conversations', '2026-01-01', 'images', 'a.png'), image);
    await fs.writeFile(path.join(f.source, 'conversations', 'turn.jsonl'), [JSON.stringify({ type: 'header', custom: '原格式字段' }),
      JSON.stringify({ type: 'turn', turn_id: 1, timestamp: '2026-01-01T08:00:00', user: '用户原话', assistant: '助手推测', images: ['2026-01-01/images/a.png'], metadata: { future: true } }),
      JSON.stringify({ type: 'footer', custom: '结束字段' })].join('\n'));
    await fs.writeFile(path.join(f.source, 'old-index.db'), randomBytes(37));
    return { text, image };
  }
  test('完整保存原文和二进制，保留发言者与附件，重复导入不覆盖人工编辑', async () => {
    const input = await source(), result = await importLifeBook(f.store, f.source, { actorId: 'owner' });
    const data = await f.store.getRecord(MEMORY_IMPORT_NAMESPACE, result.id) as MemoryImportDataset;
    expect(result.verification).toMatchObject({ verified: true, files: 4 });
    expect(data.originalFileCount).toBe(4); expect(data.attachments).toHaveLength(1);
    const scope = longMemoryScope('owner', 'library', 'real', data.id), archive = await f.store.longMemoryExport([scope]);
    expect(archive.records.every(record => record.confidence === 'inferred')).toBe(true);
    expect(archive.records.map(record => record.text).join('')).toContain('助手（模型输出）');
    const doc = data.files.find(file => file.path.endsWith('note.md'))!;
    const segments = data.segments.filter(segment => segment.fileId === doc.id).sort((a, b) => a.start - b.start);
    expect(segments.map(segment => archive.records.find(record => record.id === segment.recordId)!.text).join('')).toBe(input.text);
    const imageFile = data.files.find(file => file.path.endsWith('a.png'))!;
    const image = Buffer.concat(await Promise.all(Array.from({ length: imageFile.chunks }, async (_, index) => Buffer.from(await readImportFileChunk(f.store, data.id, imageFile, index)))));
    expect(image).toEqual(input.image);
    const record = archive.records[0];
    await f.store.longMemoryWrite({ scope, records: [{ ...record, text: '人工核对后的文本', expectedVersion: 1, confidence: 'confirmed' }] });
    expect((await importLifeBook(f.store, f.source, { actorId: 'owner' })).alreadyImported).toBe(true);
    expect((await f.store.longMemoryRevisions({ scope, id: record.id }))[0].text).toBe('人工核对后的文本');
    await expect(importLibraryFiles(f.store, 'someone-else', data.id)).rejects.toThrow('当前账号');
    const page = await importLibraryFiles(f.store, 'owner', data.id, { query: 'conversations', limit: 1 });
    expect(page.total).toBe(2); expect(page.nextOffset).toBe(1);
    expect((await f.store.verify()).ok).toBe(true);
  });
  test('关闭召回时隔离，明确开启后仅加入私人真实范围，角色和群聊保持隔离', async () => {
    await source(); const result = await importLifeBook(f.store, f.source, { actorId: 'owner' });
    const app = { storage: f.store, conversation: async () => {},
      subagents: { rootConversationId: (id: string) => id } } as any;
    const actor = { id: 'owner', role: 'owner' } as any;
    expect((await conversationMemoryScopes(app, actor))).toHaveLength(1);
    expect((await listImportLibraries(f.store, 'owner'))[0].recallEnabled).toBe(false);
    await setImportRecall(f.store, 'owner', result.id, true);
    expect((await conversationMemoryScopes(app, actor)).map(scope => scope.id)).toContain(result.scopeId);
    const character = { id: 'character', custom: { platformMode: 'character' } } as any;
    expect((await conversationMemoryScopes(app, actor, character)).map(scope => scope.id)).not.toContain(result.scopeId);
    await f.store.putRecord({ namespace: BOT_CHANNEL_ACCESS, id: 'group', value: { version: 1, context: { direct: false, platform: 'discord', botId: 'bot', channelId: 'group' } } });
    expect((await conversationMemoryScopes(app, actor, { id: 'group', actorId: 'owner' } as any)).map(scope => scope.id)).not.toContain(result.scopeId);
    await setImportRecall(f.store, 'owner', result.id, false);
    expect((await conversationMemoryScopes(app, actor))).toHaveLength(1);
  });
  test('目录改变时不发布，存储发布失败时回滚记忆写入', async () => {
    await source(); let changed = false;
    await expect(importLifeBook(f.store, f.source, { actorId: 'owner', onProgress(progress) {
      if (progress.phase === '保存原始档案' && !changed) { changed = true; writeFileSync(path.join(f.source, 'new.txt'), '来源后来新增的文件'); }
    } })).rejects.toThrow('来源目录发生变化');
    expect(await f.store.listRecords(MEMORY_IMPORT_NAMESPACE)).toEqual([]);
    expect(await f.store.longMemoryScopes('owner')).toEqual([]);
    const scope = longMemoryScope('owner', 'personal');
    await f.store.putRecord({ namespace: 'fixture', id: 'publication', value: true });
    await expect(f.store.longMemoryRestore({ actorId: 'owner', archive: { format: 'graycode-long-memory', version: 1, createdAt: 1,
      scopes: [{ ...scope, revision: 0, invalidation: 0 }], sources: [{ id: 's', scopeId: scope.id, version: 1, origin: 'import', text: '原文', recordedAt: 1 }], records: [], tombstones: [] },
      publication: [{ namespace: 'fixture', id: 'publication', value: false, expectedRevision: null }] })).rejects.toThrow();
    expect(await f.store.longMemoryScopes('owner')).toEqual([]);
  });
  test('选择性恢复记忆时包含整个原始档案组，文件校验能发现缺块', async () => {
    await source(); const result = await importLifeBook(f.store, f.source, { actorId: 'owner' });
    const destination = await fixture();
    try {
      const catalog = await restoreCatalog(f.store, destination.store);
      const plan = selectBackupRestore(catalog, { mode: 'selective', expectedPreview: catalog.preview.fingerprint, categories: [{ id: 'memories', conflict: 'keep' }] });
      expect(plan.groups.some(group => group.id === `memory-import:${result.id}` && group.units.length > 4)).toBe(true);
      expect(catalog.preview.categories.find(category => category.id === 'other')?.count).toBe(0);
      const data = await f.store.getRecord(MEMORY_IMPORT_NAMESPACE, result.id) as MemoryImportDataset;
      const file = data.files[0];
      await f.store.deleteRecord('long-memory-import-file', `${data.id}/${file.id}/0`);
      await expect(verifyImportFiles(f.store, data.id, data.files)).rejects.toThrow('文件块缺失');
    } finally { await destination.cleanup(); }
  });
  test('校验图谱源库并保留实际关系、历史有效期与原始向量', async () => {
    const database = Buffer.from('合成 Kuzu 原始内容'); await fs.writeFile(path.join(f.source, '.graphiti.kuzu'), database);
    const entity = (uuid: string, offset: number) => ({ _id: { table: 0, offset }, uuid, name: uuid, summary: '实体说明', name_embedding: [0.25], created_at: { $type: 'datetime', value: '2026-01-01T00:00:00' } });
    const graph = { format: 'lifebook-kuzu-export', version: 1, sourceFiles: [{ name: '.graphiti.kuzu', sha256: importHash(database) }], tables: [
      { name: 'Entity', type: 'NODE', rows: [entity('one', 0), entity('two', 1)] },
      { name: 'RelatesToNode_', type: 'NODE', rows: [{ _id: { offset: 0, table: 1 }, uuid: 'relation', fact: 'one 曾经使用 two', name: '使用', episodes: [], fact_embedding: [0.7],
        created_at: '2026-01-01T00:00:00', valid_at: '2026-01-01T00:00:00', invalid_at: '2026-01-02T00:00:00' }] },
      { name: 'RELATES_TO', type: 'REL', rows: [{ _src: { table: 0, offset: 0 }, _dst: { table: 1, offset: 0 } }, { _src: { table: 1, offset: 0 }, _dst: { table: 0, offset: 1 } }] },
    ] };
    const graphPath = path.join(f.root, 'graph.json'); await fs.writeFile(graphPath, JSON.stringify(graph));
    const result = await importLifeBook(f.store, f.source, { actorId: 'owner', graphExport: graphPath });
    expect(result.graph).toMatchObject({ entities: 2, facts: 1, connections: 2 });
    const scope = longMemoryScope('owner', 'library', 'real', result.id), archive = await f.store.longMemoryExport([scope]);
    const fact = archive.records.find(record => record.attribute === '使用')!;
    expect(fact.dependencies.filter(ref => ref.kind === 'record')).toHaveLength(2);
    expect(fact.validFrom).toBe(Date.parse('2026-01-01T00:00:00Z')); expect(fact.validTo).toBe(Date.parse('2026-01-02T00:00:00Z'));
    const data = await f.store.getRecord(MEMORY_IMPORT_NAMESPACE, result.id) as MemoryImportDataset, raw = data.files.find(file => file.path === '@migration/graph-export.json')!;
    expect(JSON.parse(Buffer.from(await readImportFileChunk(f.store, data.id, raw, 0)).toString()).tables[0].rows[0].name_embedding).toEqual([0.25]);
    const query = { scopes: [scope], asOf: Date.parse('2026-01-01T12:00:00Z'), knownAt: Date.now(), limit: 20, tokenBudget: 16000, confirmedOnly: false, kinds: ['fact'] as const };
    expect((await f.store.longMemoryRecall({ ...query, kinds: [...query.kinds] })).hits.some(hit => hit.record.id === fact.id)).toBe(true);
    const reviewedEntityRecord = archive.records.find(record => record.subject === 'one' && record.id !== fact.id)!;
    await f.store.longMemoryWrite({ scope, records: [{ ...reviewedEntityRecord, expectedVersion: reviewedEntityRecord.version, confidence: 'confirmed', recordedAt: Date.now() }] });
    expect((await f.store.longMemoryRecall({ ...query, knownAt: Date.now(), kinds: [...query.kinds] })).hits.some(hit => hit.record.id === fact.id)).toBe(true);
  });
});
