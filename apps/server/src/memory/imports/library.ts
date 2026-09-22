import type { PlatformStorage } from '@graycode/core';
import { MEMORY_IMPORT_NAMESPACE, MEMORY_IMPORT_POLICY_NAMESPACE, type MemoryImportDataset, type MemoryImportPolicy, type MemoryImportSummary } from '@graycode/contracts';
import { longMemoryScope } from '../longTerm/scopes';
import { readImportFileChunk } from './files';

const summaryFields = ['id','actorId','name','scopeId','fingerprint','format','version','importedAt','originalFileCount','bytes','records','sources','graph','notes','files'];

export async function importDataset(storage: PlatformStorage, actorId: string, id: string, fields?: string[]): Promise<MemoryImportDataset> {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('导入资料库编号无效。');
  const saved = await storage.getVersionedRecord(MEMORY_IMPORT_NAMESPACE, id, fields ? { fields: [...fields, 'id', 'actorId', 'scopeId'] } : undefined);
  const data = saved.value as MemoryImportDataset | null;
  if (!data || data.actorId !== actorId) throw new Error('导入资料库不属于当前账号或已不存在。');
  return data;
}

export async function listImportLibraries(storage: PlatformStorage, actorId: string): Promise<MemoryImportSummary[]> {
  const ids = await storage.listRecords(MEMORY_IMPORT_NAMESPACE, actorId);
  const policy = await storage.getRecord(MEMORY_IMPORT_POLICY_NAMESPACE, actorId) as MemoryImportPolicy | null;
  return Promise.all(ids.map(async id => {
    const { files, ...value } = await importDataset(storage, actorId, id, summaryFields);
    return { ...value, fileCount: files.length, recallEnabled: !!policy?.enabledScopes.some(scope => scope.id === value.scopeId) };
  }));
}

export async function setImportRecall(storage: PlatformStorage, actorId: string, id: string, enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('请明确指定是否启用资料库召回。');
  const data = await importDataset(storage, actorId, id, []);
  const saved = await storage.getVersionedRecord(MEMORY_IMPORT_POLICY_NAMESPACE, actorId);
  const scopes = ((saved.value as MemoryImportPolicy | null)?.enabledScopes ?? []).filter(scope => scope.id !== data.scopeId);
  const scope = longMemoryScope(actorId, 'library', 'real', id);
  if (scope.id !== data.scopeId) throw new Error('资料库范围校验失败。');
  if (enabled) scopes.push(scope);
  await storage.commitRecords([{ namespace: MEMORY_IMPORT_POLICY_NAMESPACE, id: actorId, ownerId: actorId, expectedRevision: saved.revision, value: { enabledScopes: scopes } satisfies MemoryImportPolicy }]);
  return { scopeId: scope.id, recallEnabled: enabled };
}

export async function importLibraryFiles(storage: PlatformStorage, actorId: string, id: string, options: { query?: string; offset?: number; limit?: number } = {}) {
  const data = await importDataset(storage, actorId, id, ['files']);
  const offset = options.offset ?? 0, limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('文件列表分页范围无效。');
  if (options.query !== undefined && typeof options.query !== 'string') throw new Error('文件搜索内容无效。');
  const query = options.query?.trim().toLocaleLowerCase(), files = query ? data.files.filter(file => file.path.toLocaleLowerCase().includes(query)) : data.files;
  return { files: files.slice(offset, offset + limit), total: files.length, offset, ...(offset + limit < files.length ? { nextOffset: offset + limit } : {}) };
}

export async function importFileChunk(storage: PlatformStorage, actorId: string, id: string, fileId: string, index: number) {
  const data = await importDataset(storage, actorId, id, ['files']), file = data.files.find(file => file.id === fileId);
  if (!file) throw new Error('原始文件不存在。');
  return { data: Buffer.from(await readImportFileChunk(storage, id, file, index)).toString('base64'), index };
}

export async function importSourceFiles(storage: PlatformStorage, actorId: string, id: string, sourceId: string) {
  const data = await importDataset(storage, actorId, id, ['files', 'segments', 'attachments']);
  const ids = new Set([...data.segments.filter(segment => segment.sourceId === sourceId).map(segment => segment.fileId),
    ...data.attachments.filter(item => item.sourceId === sourceId).flatMap(item => item.fileIds)]);
  return data.files.filter(file => ids.has(file.id));
}
