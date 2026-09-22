import type { LongMemoryRecord, MemoryImportDataset } from '@graycode/contracts';
import type { SourceFile } from './files';
import { decodeImportText } from './lifebook';
import { ImportedMemoryBuilder } from './text';

type Row = Record<string, any>;
interface ExportTable { name: string; type: string; rows: Row[] }
const internalKey = (id: unknown) => JSON.stringify(id && typeof id === 'object' ? Object.entries(id).sort(([a], [b]) => a.localeCompare(b)) : id);
const sourceText = (row: Row) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'name_embedding' && name !== 'fact_embedding')), null, 2);
const references = (records: LongMemoryRecord[]) => records.map(record => ({ kind: 'record' as const, id: record.id, version: 1 }));

function graphTime(value: unknown): number | undefined {
  if (value === undefined || value === null) return;
  const text = typeof value === 'string' ? value : (value as { value?: unknown }).value;
  if (typeof text !== 'string') throw new Error('图谱时间字段格式无效。');
  // Graphiti 的 ensure_utc 将不带时区的 Kuzu TIMESTAMP 解释为 UTC。
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text + 'Z';
  const timestamp = Date.parse(utc); if (!Number.isFinite(timestamp)) throw new Error('图谱时间字段无法解析。'); return timestamp;
}

export async function readLifeBookGraph(file: SourceFile, originalFiles: SourceFile[], builder: ImportedMemoryBuilder): Promise<{ statistics: NonNullable<MemoryImportDataset['graph']>; missingEpisodeReferences: number }> {
  const value = JSON.parse(await decodeImportText(file)) as { format?: string; version?: number; sourceFiles?: Array<{ name: string; sha256: string }>; tables?: ExportTable[] };
  if (value.format !== 'lifebook-kuzu-export' || value.version !== 1 || !Array.isArray(value.tables)) throw new Error('需要使用 LifeBook 图谱导出工具生成完整 JSON。');
  if (!value.sourceFiles?.length) throw new Error('图谱导出缺少原数据库校验值，请使用当前导出脚本重新生成。');
  for (const source of value.sourceFiles) if (!originalFiles.some(file => file.path === source.name && file.sha256 === source.sha256)) throw new Error('图谱导出与选定目录中的原数据库不一致。');
  const tables = new Map(value.tables.map(table => [table.name, table]));
  const entities = tables.get('Entity')?.rows ?? [], facts = tables.get('RelatesToNode_')?.rows ?? [], episodes = tables.get('Episodic')?.rows ?? [];
  const connections = tables.get('RELATES_TO')?.rows ?? [];
  const incomingByKey = new Map<string, Row[]>(), outgoingByKey = new Map<string, Row[]>();
  for (const edge of connections) {
    const from = internalKey(edge._src), to = internalKey(edge._dst);
    outgoingByKey.set(from, [...outgoingByKey.get(from) ?? [], edge]);
    incomingByKey.set(to, [...incomingByKey.get(to) ?? [], edge]);
  }
  const entityByKey = new Map(entities.map(row => [internalKey(row._id), row]));
  const entityRecords = new Map<string, LongMemoryRecord[]>(), episodeRecords = new Map<string, LongMemoryRecord[]>();
  let missingEpisodeReferences = 0;
  for (const entity of entities) {
    if (typeof entity.uuid !== 'string' || typeof entity.name !== 'string') throw new Error('图谱实体缺少稳定编号或名称。');
    const text = [entity.name, entity.summary, entity.attributes && entity.attributes !== '{}' ? `原始属性：${entity.attributes}` : ''].filter(value => typeof value === 'string' && value.trim()).join('\n\n');
    entityRecords.set(entity.uuid, builder.add(file, `graph:entity:${entity.uuid}`, text, { subject: entity.name, topic: ['LifeBook','图谱实体',entity.name],
      raw: sourceText(entity), representation: 'normalized', sourceLabel: 'LifeBook 图谱实体原始字段（向量见原始数据库）', recordedAt: graphTime(entity.created_at) }));
  }
  for (const episode of episodes) {
    if (typeof episode.uuid !== 'string' || typeof episode.content !== 'string') throw new Error('图谱事件缺少编号或正文。');
    episodeRecords.set(episode.uuid, builder.add(file, `graph:episode:${episode.uuid}`, episode.content || sourceText(episode), { kind: 'event', subject: episode.name || '图谱事件',
      topic: ['LifeBook','图谱事件'], representation: 'normalized', recordedAt: graphTime(episode.created_at), eventAt: graphTime(episode.valid_at), sourceLabel: 'LifeBook 图谱事件' }));
  }
  for (const fact of facts) {
    if (typeof fact.uuid !== 'string' || typeof fact.fact !== 'string') throw new Error('图谱事实缺少编号或正文。');
    const key = internalKey(fact._id), incoming = incomingByKey.get(key) ?? [], outgoing = outgoingByKey.get(key) ?? [];
    if (incoming.length !== 1 || outgoing.length !== 1) throw new Error('图谱事实的实体连接不是一对一，请先检查原始图谱。');
    const from = entityByKey.get(internalKey(incoming[0]._src)), to = entityByKey.get(internalKey(outgoing[0]._dst));
    if (!from || !to) throw new Error('图谱事实引用了不存在的实体。');
    const dependencies = [...references((entityRecords.get(from.uuid) ?? []).slice(0, 1)), ...references((entityRecords.get(to.uuid) ?? []).slice(0, 1))];
    for (const id of fact.episodes ?? []) {
      const records = episodeRecords.get(id);
      if (records?.length) dependencies.push(...references(records.slice(0, 1))); else missingEpisodeReferences++;
    }
    const unique = [...new Map(dependencies.map(ref => [ref.id, ref])).values()];
    const recordedAt = graphTime(fact.created_at), validFrom = graphTime(fact.valid_at) ?? recordedAt, validTo = graphTime(fact.invalid_at);
    if (validTo !== undefined && validFrom !== undefined && validTo <= validFrom) throw new Error('图谱事实的有效截止不晚于起始，原始时间需要人工核对。');
    builder.add(file, `graph:fact:${fact.uuid}`, fact.fact || `${from.name} · ${fact.name} · ${to.name}`, { subject: from.name, attribute: fact.name, value: to.name,
      topic: ['LifeBook','图谱关系',String(fact.name || '未分类')], raw: sourceText(fact), representation: 'normalized', dependencies: unique,
      sourceLabel: 'LifeBook 图谱事实原始字段（向量见原始数据库）', recordedAt, validFrom, validTo,
      ...(fact.expired_at && !fact.invalid_at ? {prefix:'原系统已弃用的历史关系，原始过期时间见来源。'} : {}) });
  }
  const supported = new Set(['Entity','RelatesToNode_','Episodic']);
  for (const table of value.tables) if (table.type === 'NODE' && !supported.has(table.name)) for (const [index,row] of table.rows.entries())
    builder.add(file, `graph:other:${table.name}:${index}`, sourceText(row), {kind:'event',topic:['LifeBook','其他图谱节点',table.name],representation:'normalized'});
  return {statistics:{entities:entities.length,facts:facts.length,episodes:episodes.length,connections:value.tables.filter(table=>table.type==='REL').reduce((sum,table)=>sum+table.rows.length,0)},missingEpisodeReferences};
}
