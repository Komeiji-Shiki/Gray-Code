import type { PlatformStorage } from '@graycode/core';
import { MEMORY_IMPORT_NAMESPACE, type MemoryImportDataset, type LongMemoryRecord } from '@graycode/contracts';

/** 只修正旧转换器生成且尚未编辑的图谱条目，以后续修订保留原始转换记录。 */
export async function upgradeLifeBookGraphAssociations(storage: PlatformStorage, id: string) {
  const header = (await storage.getVersionedRecord(MEMORY_IMPORT_NAMESPACE, id, { fields: ['format','version','graph','graphAssociationsVersion'] })).value as MemoryImportDataset | null;
  if (!header || header.format !== 'lifebook' || header.version !== 1 || !header.graph || header.graphAssociationsVersion === 1) return { revised: 0, edited: 0 };
  const saved = await storage.getVersionedRecord(MEMORY_IMPORT_NAMESPACE, id), data = saved.value as MemoryImportDataset;
  const scope = (await storage.longMemoryScopes(data.actorId)).find(scope => scope.id === data.scopeId);
  if (!scope || scope.kind !== 'library' || scope.key !== id) throw new Error('导入图谱的范围信息不一致，请先核对备份。');
  const archive = await storage.longMemoryExport([scope]);
  const originals = archive.records.filter(record => record.version === 1 && record.origin === 'import' && record.topic[0] === 'LifeBook');
  const entities = new Set(originals.filter(record => record.topic[1] === '图谱实体').map(record => record.id));
  const latest = new Map<string, LongMemoryRecord>();
  for (const record of archive.records) if (!latest.has(record.id) || latest.get(record.id)!.version < record.version) latest.set(record.id, record);
  const corrections: LongMemoryRecord[] = []; let edited = 0;
  for (const original of originals.filter(record => record.topic[1] === '图谱关系')) {
    if (!original.dependencies.some(ref => ref.kind === 'record' && entities.has(ref.id) && !ref.association)) continue;
    const current = latest.get(original.id)!;
    if (current.version !== 1) { edited++; continue; }
    corrections.push({ ...current, version: 2, recordedAt: Math.max(Date.now(), current.recordedAt),
      dependencies: current.dependencies.map(ref => ref.kind === 'record' && entities.has(ref.id) ? { ...ref, association: true } : ref) });
  }
  const notes = [...data.notes, '原始图谱的实体连接已标记为关联，原文和旧修订继续保留。',
    ...(edited ? [`${edited} 条已编辑的图谱记忆保持现有引用，可在关系图中逐条核对。`] : [])];
  const result = await storage.longMemoryRestore({ actorId: data.actorId, archive: { ...archive, sources: [], records: corrections, tombstones: [] },
    copyVectors: corrections.map(record=>({scopeId:scope.id,id:record.id,from:1,to:record.version})),
    publication: [{ namespace: MEMORY_IMPORT_NAMESPACE, id, ownerId: data.actorId, expectedRevision: saved.revision, value: { ...data, graphAssociationsVersion: 1, notes } satisfies MemoryImportDataset }] });
  return { revised: result.records, edited };
}

export async function upgradeImportedMemoryGraphs(storage: PlatformStorage) {
  for (const id of await storage.listRecords(MEMORY_IMPORT_NAMESPACE)) await upgradeLifeBookGraphAssociations(storage, id);
}
