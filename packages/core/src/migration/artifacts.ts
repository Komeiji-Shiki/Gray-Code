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

async function sourceBytes(file: string, root: string): Promise<Buffer> {
  const canonical = await fs.realpath(file);
  const relative = path.relative(root, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('源文件位于选定迁移目录之外。');
  const info = await fs.stat(canonical);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('源文件类型或大小不受支持。');
  return fs.readFile(canonical);
}

async function json(file: string, root: string): Promise<unknown> {
  const bytes = await sourceBytes(file, root);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

async function putJson(store: PlatformStorage, namespace: string, id: string, ownerId: string, value: unknown): Promise<void> {
  const current = await store.getVersionedRecord(namespace, id);
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
      await putJson(store, record.namespace, record.id, record.ownerId ?? 'legacy', record.value);
    }
  };
  let completed = 0;
  for (const conversationId of options.conversationIds) {
    options.signal?.throwIfAborted();
    progress('导入分支、用量与检查点', conversationId, { conversationId, completed, total: options.conversationIds.length, unit: '个对话' });
    if (!safeId.test(conversationId) || !await store.getConversation(conversationId)) continue;
    const branch = path.join(conversations, conversationId, 'branches.json');
    if (await regular(branch)) {
      try { const value = await json(branch, root); await putJson(store, 'legacy-source-artifacts', `branch:${conversationId}`, conversationId, value); if (options.convertBranch) { await putJson(store, 'conversation-branches', conversationId, conversationId, await options.convertBranch(conversationId, value)); result.imported.branches.push(conversationId); result.consumed.add(branch); } }
      catch (error) { result.issues.push({ conversationId, path: branch, code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const usage = path.join(conversations, `${conversationId}.usage.json`);
    if (await regular(usage)) {
      try { const value = await json(usage, root); await putJson(store, 'legacy-source-artifacts', `usage:${conversationId}`, conversationId, value); await putJson(store, 'conversation-usage', conversationId, conversationId, options.convertUsage ? await options.convertUsage(conversationId, value) : value); result.imported.usage.push(conversationId); result.consumed.add(usage); }
      catch (error) { result.issues.push({ conversationId, path: usage, code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const diffDir = path.join(root, 'diffs', conversationId);
    try {
      for (const entry of await fs.readdir(diffDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(diffDir, entry.name); const id = entry.name.slice(0, -5);
        if (!safeId.test(id)) continue;
        try { const value = await json(file, root); await putJson(store, 'legacy-source-artifacts', `diff:${conversationId}:${id}`, conversationId, value); await putJson(store, 'conversation-diffs', `${conversationId}:${id}`, conversationId, value); result.imported.diffs.push(`${conversationId}:${id}`); result.consumed.add(file); }
        catch (error) { result.issues.push({ conversationId, path: file, code: 'CORRUPT_DATA', message: String(error) }); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ conversationId, path: diffDir, code: 'IO_ERROR', message: String(error) }); }
    if (options.convertCheckpoint) {
      try {
        checkpointProgress = undefined;
        const converted = await options.convertCheckpoint(conversationId, root, { signal: options.signal,
          onStatus: value => { checkpointProgress = value; options.onStatus?.(value); },
          writeRecords: records => writeCheckpointRecords(records.map(record => ({ ...record, ownerId: record.ownerId ?? conversationId }))) });
        result.issues.push(...converted.issues ?? []);
        await writeCheckpointRecords(converted.records.map(record => ({ ...record, ownerId: record.ownerId ?? conversationId })));
        for (const file of converted.consumed) { result.imported.checkpoints.push(file); result.consumed.add(file); }
      } catch (error) { result.issues.push({ conversationId, path: path.join(root, 'checkpoints'), code: 'CORRUPT_DATA', message: String(error) }); }
    }
    const transcripts = path.join(conversations, conversationId, 'subagents');
    for (const entry of await directoryEntries(transcripts)) if (entry.isFile() && entry.name.endsWith('.json')) {
      options.signal?.throwIfAborted();
      const file = path.join(transcripts, entry.name);
      progress('导入子代理记录', file, { conversationId });
      try {
        const runId = decodeURIComponent(entry.name.slice(0, -5));
        const value = await json(file, root);
        if (!value || typeof value !== 'object') throw new Error('子代理记录格式无效。');
        await putJson(store, 'subagent-transcript', JSON.stringify([conversationId, runId]), conversationId, value);
        result.imported.subagents.push(runId); result.consumed.add(file);
      } catch (error) { result.issues.push({ conversationId, path: file, code: 'CORRUPT_DATA', message: String(error) }); }
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
      const value = await json(file, root) as SnapshotMetadata & { history: PlatformMessage[] };
      if (!options.conversationIds.includes(value.conversationId)) continue;
      if (!safeId.test(value.id) || !Array.isArray(value.history)) throw new Error('历史快照缺少标识或正文。');
      const existing = await store.getSnapshot(value.id);
      if (existing && !isDeepStrictEqual(existing, value)) throw new Error('目标存在不同内容的历史快照，未覆盖。');
      if (!existing) { const { history, ...metadata } = value; await store.saveSnapshot(metadata, history); }
      result.imported.snapshots.push(value.id); result.consumed.add(file);
    } catch (error) { result.issues.push({ path: file, code: 'CORRUPT_DATA', message: String(error) }); }
  }
  const attachmentRoot = path.join(root, 'attachments');
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      options.signal?.throwIfAborted();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        progress('导入附件', file);
        const bytes = new Uint8Array(await sourceBytes(file, root)); const id = digest(bytes);
        await putJson(store, 'legacy-attachments', id, 'legacy', bytes);
        await putJson(store, 'legacy-attachment-paths', digest(Buffer.from(root + '\0' + path.relative(root, file))), 'legacy', { source: root, path: path.relative(root, file), contentId: id });
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
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push({ path: attachmentRoot, code: 'IO_ERROR', message: String(error) }); }
  options.signal?.throwIfAborted();
  return result;
}
