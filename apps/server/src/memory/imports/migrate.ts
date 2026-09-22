import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateLegacyImportPaths, type PlatformStorage } from '@graycode/core';
import { MEMORY_IMPORT_NAMESPACE, MEMORY_IMPORT_FILE_NAMESPACE, type MemoryImportDataset } from '@graycode/contracts';
import { longMemoryScope } from '../longTerm/scopes';
import { importHash, inspectImportFile, inspectImportFiles, storeImportFile, verifyImportFiles, type SourceFile } from './files';
import { decodeImportText, readLifeBookDocuments } from './lifebook';
import { readLifeBookGraph } from './graph';
import { ImportedMemoryBuilder } from './text';
import { upgradeLifeBookGraphAssociations } from './upgrades';

export interface LifeBookImportOptions {
  actorId: string; name?: string; graphExport?: string; sourceManifest?: string; signal?: AbortSignal;
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
}

async function applySourceManifest(files: SourceFile[], manifest: SourceFile) {
  const data = JSON.parse(await decodeImportText(manifest)) as { format: string; version: number; files: Array<{ path: string; bytes: number; sha256: string; createdAt: string; modifiedAt: string }> };
  if (data.format !== 'graycode-source-snapshot' || data.version !== 1 || !Array.isArray(data.files)) throw new Error('原始快照清单格式无效。');
  const entries = new Map(data.files.map(file => [file.path, file]));
  if (entries.size !== data.files.length || entries.size !== files.length) throw new Error('快照清单的文件集合与来源不一致。');
  for (const file of files) {
    const entry = entries.get(file.path);
    if (!entry || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes) throw new Error(`快照清单校验失败：${file.path}`);
    if (![entry.modifiedAt, entry.createdAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) throw new Error('快照清单包含无效时间。');
    file.modifiedAt = entry.modifiedAt; file.createdAt = entry.createdAt;
  }
}

/** 原始档案先校验，再与可编辑条目一起发布；中断后按稳定编号继续，未发布的块不会参与召回。 */
export async function importLifeBook(storage: PlatformStorage, directory: string, options: LifeBookImportOptions) {
  const root = await validateLegacyImportPaths(directory, storage.directory);
  if (!options.actorId.trim()) throw new Error('导入需要明确指定目标账号。');
  const originals = await inspectImportFiles(root, options.signal);
  if (!originals.length) throw new Error('所选目录没有可导入文件。');
  const extras: SourceFile[] = [];
  if (options.sourceManifest) {
    const manifest = await inspectImportFile(path.resolve(options.sourceManifest), '@migration/source-manifest.json', options.signal);
    await applySourceManifest(originals, manifest); extras.push(manifest);
  }
  const graphFile = options.graphExport ? await inspectImportFile(path.resolve(options.graphExport), '@migration/graph-export.json', options.signal) : undefined;
  if (originals.some(file => /\.kuzu$/i.test(file.path)) && !graphFile) throw new Error('目录包含 Kuzu 图谱，请先运行 scripts/export-lifebook-graph.py 并传入 --graph-export。');
  if (graphFile) {
    // 导出时间不作为记忆发生时间，保持同一来源的转换结果稳定。
    graphFile.modifiedAt = originals.find(file => /\.kuzu\.wal$/i.test(file.path))?.modifiedAt ?? originals.find(file => /\.kuzu$/i.test(file.path))?.modifiedAt;
    extras.push(graphFile);
  }
  const files = [...originals, ...extras];
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('来源使用了保留的迁移文件路径。');
  const fingerprint = importHash(JSON.stringify(files.map(file => [file.path, file.sha256])));
  const id = importHash(JSON.stringify(['lifebook', 1, options.actorId, fingerprint]));
  const existing = await storage.getRecord(MEMORY_IMPORT_NAMESPACE, id) as MemoryImportDataset | null;
  if (existing) { await upgradeLifeBookGraphAssociations(storage, id); return { id, scopeId: existing.scopeId, alreadyImported: true, records: existing.records, sources: existing.sources,
    graph: existing.graph, notes: existing.notes, originalFiles: existing.originalFileCount,
    verification: await verifyImportFiles(storage, id, existing.files, options.signal) }; }
  const scope = longMemoryScope(options.actorId, 'library', 'real', id), builder = new ImportedMemoryBuilder(scope, id);
  options.onProgress?.({ phase: '解析文档与对话', completed: 0, total: originals.length });
  const documents = await readLifeBookDocuments(originals, builder, options.signal);
  const graph = graphFile ? await readLifeBookGraph(graphFile, originals, builder) : undefined;
  const notes = [
    '导入条目均为待核对；资料库的自动召回初始关闭，确认条目并启用后才参与私人对话。',
    '原始文件按字节完整保存。可编辑条目以版本保存，旧索引和向量未混入新检索。',
    `已解析 ${documents.documents} 份 Markdown、${documents.turns} 个对话回合；用户和助手发言分别标注。`,
    ...(documents.unrecognizedLines ? [`${documents.unrecognizedLines} 行非标准对话已按原文保留。`] : []),
    ...(documents.missingImages.length ? [`原库缺少 ${documents.missingImages.length} 个被引用图片文件，原始引用仍保留在日志中。`] : []),
    ...(graph?.missingEpisodeReferences ? [`图谱包含 ${graph.missingEpisodeReferences} 个未导出的事件引用，保留原编号，没有补造来源。`] : []),
  ];
  const dataset: MemoryImportDataset = { id, actorId: options.actorId, name: options.name?.trim().slice(0, 160) || 'LifeBook 导入资料库', scopeId: scope.id,
    fingerprint, format: 'lifebook', version: 1, importedAt: Date.now(), files: files.map(({ absolute, ...file }) => file), originalFileCount: originals.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0), records: builder.records.length, sources: builder.sources.length,
    segments: builder.segments, attachments: builder.attachments, notes, ...(graph ? { graph: graph.statistics, graphAssociationsVersion: 1 } : {}) };
  const saved = new Set(await storage.listRecords(MEMORY_IMPORT_FILE_NAMESPACE, id));
  for (const [index, file] of files.entries()) {
    await storeImportFile(storage, id, file, saved, options.signal);
    options.onProgress?.({ phase: '保存原始档案', completed: index + 1, total: files.length });
  }
  const verification = await verifyImportFiles(storage, id, dataset.files, options.signal);
  // 再查整个路径集合，既捕获内容变化，也捕获扫描后新增、删除的文件。
  const final = await inspectImportFiles(root, options.signal);
  if (JSON.stringify(final.map(file => [file.path, file.sha256])) !== JSON.stringify(originals.map(file => [file.path, file.sha256]))) throw new Error('导入期间来源目录发生变化，资料库尚未发布，请重新导入。');
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: '发布可编辑资料库', completed: 0, total: dataset.records });
  const result = await storage.longMemoryRestore({ actorId: options.actorId, archive: builder.archive(), publication: [
    { namespace: MEMORY_IMPORT_NAMESPACE, id, ownerId: options.actorId, expectedRevision: null, value: dataset },
  ] });
  return { id, scopeId: scope.id, alreadyImported: false, ...result, originalFiles: originals.length, verification, graph: graph?.statistics, notes };
}
