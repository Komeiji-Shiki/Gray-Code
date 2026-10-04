import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { MigrationIssue, MigrationProgress, PlatformMessage, SnapshotMetadata, StoredRecord } from '@graycode/contracts';
import { PlatformStorage } from '../storage/client';

export interface LegacyCheckpointConverter {
  (conversationId: string, sourceRoot: string, context?: {
    signal?: AbortSignal;
    onStatus?: (progress: MigrationProgress) => void;
    /** 转换一个检查点后立即写入，避免在内存中积累整段备份历史。 */
    writeRecords?: (records: readonly StoredRecord[]) => Promise<void>;
  }): Promise<{ records: readonly StoredRecord[]; consumed: readonly string[]; issues?: MigrationIssue[] }>;
}

export interface LegacyArtifactImportOptions {
  conversationIds: readonly string[];
  signal?: AbortSignal;
  onStatus?: (progress: MigrationProgress) => void;
  includeSharedAssets?: boolean;
  convertCheckpoint?: LegacyCheckpointConverter;
  convertUsage?: (conversationId: string, value: unknown) => Promise<unknown>;
  convertBranch?: (conversationId: string, value: unknown) => Promise<unknown>;
}

export interface LegacyArtifactResult {
  imported: { branches: string[]; usage: string[]; diffs: string[]; attachments: string[]; checkpoints: string[]; snapshots: string[]; subagents: string[] };
  consumed: Set<string>;
  issues: MigrationIssue[];
}

const safeId = /^[a-zA-Z0-9_-]+$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function regular(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function directoryEntries(directory: string) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function sourceBytes(file: string, root: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const canonical = await fs.realpath(file);
  const relative = path.relative(root, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('源文件位于选定迁移目录之外。');
  const info = await fs.stat(canonical);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('源文件类型或大小不受支持。');
  return fs.readFile(canonical, { signal });
}

async function json(file: string, root: string, signal?: AbortSignal): Promise<unknown> {
  const bytes = await sourceBytes(file, root, signal);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

async function putJson(store: PlatformStorage, namespace: string, id: string, ownerId: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const current = await store.getVersionedRecord(namespace, id);
  signal?.throwIfAborted();
  if (current.revision !== null) {
    if (!isDeepStrictEqual(current.value, value)) throw new Error(`目标 ${namespace}/${id} 已存在不同内容，未覆盖。`);
    return;
  }
  await store.commitRecords([{ namespace, id, ownerId, value, expectedRevision: null }]);
}

/** 导入可识别的旧附属数据；源目录只读，目标仅写新 PlatformStorage 记录。 */
export async function importLegacyArtifacts(
  store: PlatformStorage,
  root: string,
  options: LegacyArtifactImportOptions,
): Promise<LegacyArtifactResult> {
  options.signal?.throwIfAborted();
  root = await fs.realpath(root);
  const result: LegacyArtifactResult = { imported: { branches: [], usage: [], diffs: [], attachments: [], checkpoints: [], snapshots: [], subagents: [] }, consumed: new Set(), issues: [] };
  const conversations = path.join(root, 'conversations');
  const progress = (detail: string, currentItem: string, extra: Partial<MigrationProgress> = {}) => options.onStatus?.({ phase: 'artifacts', detail, currentItem, ...extra });
  let checkpointProgress: MigrationProgress | undefined;
  const writeCheckpointRecords = async (records: readonly StoredRecord[]) => {
    const checkpoint = records.find(record => record.namespace === 'workspace-checkpoints')?.value as { contentIds?: Record<string, string> } | undefined;
    const fileNames = new Map(Object.entries(checkpoint?.contentIds ?? {}).map(([file, id]) => [id, file]));
    // 文件内容先保存，最后发布检查点清单；取消时不会留下可恢复的半个检查点。
    const ordered = [...records].sort((a, b) => Number(a.namespace === 'workspace-checkpoints') - Number(b.namespace === 'workspace-checkpoints'));
    for (const record of ordered) {
      options.signal?.throwIfAborted();
      progress('保存检查点', fileNames.get(record.id) ?? record.id, { completed: checkpointProgress?.completed, total: checkpointProgress?.total,
        unit: checkpointProgress?.unit, conversationId: checkpointProgress?.conversationId });
      await putJson(store, record.namespace, record.id, record.ownerId ?? 'legacy', record.value, options.signal);
    }
  };
  let completed = 0;
  for (const conversationId of options.conversationIds) {
    options.signal?.throwIfAborted();
    progress('导入分支、用量与检查点', conversationId, { conversationId, completed, total: options.conversationIds.length, unit: '个对话' });
    if (!safeId.test(conversationId) || !await store.getConversation(conversationId)) continue;
    const branch = path.join(conversations, conversationId, 'branches.json');
    if (await regular(branch)) {
      try { const value = await json(branch, root, options.signal); await putJson(store, 'legacy-source-artifacts', `branch:${conversationId}`, conversationId, value, options.signal); if (options.convertBranch) { await putJson(store, 'conversation-branches', conversationId, conversationId, await options.convertBranch(conversationId, value), options.signal); result.imported.branches.push(conversationId); result.consumed.add(branch); } }
      catch (error) { options.signal?.throwIfAborted(); result.issues.push({ conversationId, path: branch, code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const usage = path.join(conversations, `${conversationId}.usage.json`);
    if (await regular(usage)) {
      try { const value = await json(usage, root, options.signal); await putJson(store, 'legacy-source-artifacts', `usage:${conversationId}`, conversationId, value, options.signal); await putJson(store, 'conversation-usage', conversationId, conversationId, options.convertUsage ? await options.convertUsage(conversationId, value) : value, options.signal); result.imported.usage.push(conversationId); result.consumed.add(usage); }
      catch (error) { options.signal?.throwIfAborted(); result.issues.push({ conversationId, path: usage, code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const diffDir = path.join(root, 'diffs', conversationId);
    try {
      for (const entry of await fs.readdir(diffDir, { withFileTypes: true })) {
        options.signal?.throwIfAborted();
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(diffDir, entry.name); const id = entry.name.slice(0, -5);
        if (!safeId.test(id)) continue;
        try { const value = await json(file, root, options.signal); await putJson(store, 'legacy-source-artifacts', `diff:${conversationId}:${id}`, conversationId, value, options.signal); await putJson(store, 'conversation-diffs', `${conversationId}:${id}`, conversationId, value, options.signal); result.imported.diffs.push(`${conversationId}:${id}`); result.consumed.add(file); }
        catch (error) { options.signal?.throwIfAborted(); result.issues.push({ conversationId, path: file, code: 'CORRUPT_DATA', message: String(error) }); }
      }
    } catch (error) { options.signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ conversationId, path: diffDir, code: 'IO_ERROR', message: String(error) }); }
    if (options.convertCheckpoint) {
      try {
        checkpointProgress = undefined;
        const converted = await options.convertCheckpoint(conversationId, root, { signal: options.signal,
          onStatus: value => { checkpointProgress = value; options.onStatus?.(value); },
          writeRecords: records => writeCheckpointRecords(records.map(record => ({ ...record, ownerId: record.ownerId ?? conversationId }))) });
        result.issues.push(...converted.issues ?? []);
        await writeCheckpointRecords(converted.records.map(record => ({ ...record, ownerId: record.ownerId ?? conversationId })));
        for (const file of converted.consumed) { result.imported.checkpoints.push(file); result.consumed.add(file); }
      } catch (error) { options.signal?.throwIfAborted(); result.issues.push({ conversationId, path: path.join(root, 'checkpoints'), code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const transcripts = path.join(conversations, conversationId, 'subagents');
    for (const entry of await directoryEntries(transcripts)) if (entry.isFile() && entry.name.endsWith('.json')) {
      options.signal?.throwIfAborted();
      const file = path.join(transcripts, entry.name);
      progress('导入子代理记录', file, { conversationId });
      try {
        const runId = decodeURIComponent(entry.name.slice(0, -5));
        const value = await json(file, root, options.signal);
        if (!value || typeof value !== 'object') throw new Error('子代理记录格式无效。');
        await putJson(store, 'subagent-transcript', JSON.stringify([conversationId, runId]), conversationId, value, options.signal);
        result.imported.subagents.push(runId); result.consumed.add(file);
      } catch (error) { options.signal?.throwIfAborted(); result.issues.push({ conversationId, path: file, code: 'CORRUPT_DATA', message: String(error) }); }
    }
    completed++;
    progress('已处理对话附属数据', conversationId, { completed, total: options.conversationIds.length, unit: '个对话' });
  }
  const snapshots = path.join(root, 'snapshots');
  for (const entry of await directoryEntries(snapshots)) if (entry.isFile() && entry.name.endsWith('.json')) {
    options.signal?.throwIfAborted();
    const file = path.join(snapshots, entry.name);
    progress('导入历史快照', file);
    try {
      const value = await json(file, root, options.signal) as SnapshotMetadata & { history: PlatformMessage[] };
      if (!options.conversationIds.includes(value.conversationId)) continue;
      if (!safeId.test(value.id) || !Array.isArray(value.history)) throw new Error('历史快照缺少标识或正文。');
      const existing = await store.getSnapshot(value.id);
      options.signal?.throwIfAborted();
      if (existing && !isDeepStrictEqual(existing, value)) throw new Error('目标存在不同内容的历史快照，未覆盖。');
      if (!existing) { const { history, ...metadata } = value; await store.saveSnapshot(metadata, history); }
      result.imported.snapshots.push(value.id); result.consumed.add(file);
    } catch (error) { options.signal?.throwIfAborted(); result.issues.push({ path: file, code: 'CORRUPT_DATA', message: String(error) }); }
  }
  const attachmentRoot = path.join(root, 'attachments');
  async function visit(directory: string): Promise<void> {
    options.signal?.throwIfAborted();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      options.signal?.throwIfAborted();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        progress('导入附件', file);
        const bytes = new Uint8Array(await sourceBytes(file, root, options.signal)); const id = digest(bytes);
        await putJson(store, 'legacy-attachments', id, 'legacy', bytes, options.signal);
        await putJson(store, 'legacy-attachment-paths', digest(Buffer.from(root + '\0' + path.relative(root, file))), 'legacy', { source: root, path: path.relative(root, file), contentId: id }, options.signal);
        result.imported.attachments.push(path.relative(root, file).replaceAll('\\', '/')); result.consumed.add(file);
      }
    }
  }
  try {
    if (options.includeSharedAssets) await visit(attachmentRoot);
    else for (const conversationId of options.conversationIds) if (safeId.test(conversationId)) {
      const directory = path.join(attachmentRoot, conversationId);
      if ((await directoryEntries(directory)).length) await visit(directory);
    }
  } catch (error) { options.signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ path: attachmentRoot, code: 'IO_ERROR', message: String(error) }); }
  options.signal?.throwIfAborted();
  return result;
}
