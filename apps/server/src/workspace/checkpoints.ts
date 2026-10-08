import { workspaceFilePath, workspaceSnapshotRoots } from './paths';
import type { CheckpointOperationControl } from './checkpointOperations';
import { branchNamespace, branchMutation, readBranches, type BranchState } from '../conversations/branches';
import { validate } from '../../../../backend/modules/conversation/branch/BranchGraph';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationState, RecordMutation, WorkspaceDefinition } from '@graycode/contracts';
import type { PreparedConversationChange } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { collectWorkspaceSnapshot, type WorkspaceSnapshotBase, type WorkspaceSnapshotManifest } from './snapshot';
import { fileHash, type DirectoryChange, type FileChange, type FileTransaction } from './fileTransaction';
import { computeRestorePlan, isProtectedScopedPath } from '../../../../backend/modules/checkpoint/CheckpointRestoreEngine';
import { parseWorkspaceScopedPath } from '../../../../backend/modules/checkpoint/CheckpointWorkspace';

const namespace = 'workspace-checkpoints';
const contentsNamespace = 'workspace-checkpoint-content';
export interface WorkspaceCheckpoint {
  id: string; conversationId: string; workspaceId: string; directory: string; timestamp: number; name?: string;
  messageIndex: number; messageNodeId?: string; toolName: string; phase: 'before' | 'after'; runId?: string;
  manifest: WorkspaceSnapshotManifest; contentIds: Record<string, string>;
}
const checkpointMetadataFields = ['id', 'conversationId', 'timestamp', 'name', 'messageIndex', 'messageNodeId', 'toolName', 'phase', 'runId'] as const;
type WorkspaceCheckpointMetadata = Pick<WorkspaceCheckpoint, typeof checkpointMetadataFields[number]> & { fileCount: number; size: number; partial: boolean };
interface RestorePreview { id: string; actorId: string; checkpointId: string; fingerprint: string; createdAt: number }
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

export class WorkspaceCheckpoints {
  private readonly previews = new Map<string, RestorePreview>();
  /** 每个对话最近发布的检查点；重启后从已保存的检查点恢复复用基线。 */
  private readonly latest = new Map<string, string>();
  private readonly metadataCache = new Map<string, { revision: number | null; value: Promise<WorkspaceCheckpointMetadata> }>();
  constructor(private readonly app: PlatformApplication) {}
  /** 基线必须仍存在且属于同一工作区与目录；否则回退为独立采集。 */
  private async base(actorId: string, conversationId: string, workspace: WorkspaceDefinition, signal?: AbortSignal): Promise<WorkspaceSnapshotBase | undefined> {
    const id = this.latest.get(conversationId) ?? (await this.listMetadata(actorId, conversationId, signal)).at(-1)?.id;
    signal?.throwIfAborted();
    if (!id) return undefined;
    const value = await this.app.storage.getRecord(namespace, id) as WorkspaceCheckpoint | null;
    const roots = workspaceSnapshotRoots(workspace).map(root => `${root.id}\n${root.uri}`).join('\n');
    if (!value || value.conversationId !== conversationId || value.workspaceId !== workspace.id
      || value.manifest.roots.map(root => `${root.id}\n${root.uri}`).join('\n') !== roots) {
      this.latest.delete(conversationId);
      return undefined;
    }
    this.latest.set(conversationId, id);
    return { manifest: value.manifest, contentIds: value.contentIds };
  }
  private async workspace(actorId: string, conversationId: string, effects: ('workspace_read' | 'workspace_write')[]): Promise<WorkspaceDefinition> {
    const conversation = await this.app.conversation(actorId, conversationId);
    if (typeof conversation.workspaceId !== 'string') throw new Error('对话没有绑定工作区。');
    return this.app.workspace(actorId, conversation.workspaceId, effects);
  }
  private scan(workspace: WorkspaceDefinition, signal = new AbortController().signal, affectedPaths?: string[], base?: WorkspaceSnapshotBase) {
    return collectWorkspaceSnapshot({ workspace, config: this.app.product.runtimeSettings().getCheckpointConfig(),
      dataDirectory: this.app.storage.directory, signal, affectedPaths, base });
  }
  async get(actorId: string, conversationId: string, id: string): Promise<WorkspaceCheckpoint> {
    await this.app.conversation(actorId, conversationId);
    const value = await this.app.storage.getRecord(namespace, id) as WorkspaceCheckpoint | null;
    if (!value || value.conversationId !== conversationId) throw new Error('检查点不属于当前对话。');
    return value;
  }
  async manifest(actorId: string, id: string) {
    const value = await this.app.storage.getRecord(namespace, id) as WorkspaceCheckpoint | null;
    if (!value) throw new Error('检查点不存在。');
    await this.app.conversation(actorId, value.conversationId);
    return { manifest: { ...value.manifest, checkpointId: value.id, workspaceRoots: value.manifest.roots } };
  }
  async list(actorId: string, conversationId: string): Promise<WorkspaceCheckpoint[]> {
    await this.app.conversation(actorId, conversationId);
    const values: WorkspaceCheckpoint[] = [];
    for (const id of await this.app.storage.listRecords(namespace, conversationId)) values.push(await this.get(actorId, conversationId, id));
    return values.sort((a, b) => a.timestamp - b.timestamp);
  }
  async listMetadata(actorId: string, conversationId: string, signal?: AbortSignal): Promise<WorkspaceCheckpointMetadata[]> {
    signal?.throwIfAborted();
    await this.app.conversation(actorId, conversationId);
    const ids = await this.app.storage.listRecords(namespace, conversationId);
    const revisions = await this.app.storage.recordRevisions(ids.map(id => ({ namespace, id })));
    const values: WorkspaceCheckpointMetadata[] = [];
    for (const [index, id] of ids.entries()) {
      signal?.throwIfAborted();
      let cached = this.metadataCache.get(id);
      if (!cached || cached.revision !== revisions[index]) {
        const entry: { revision: number | null; value: Promise<WorkspaceCheckpointMetadata> } = { revision: revisions[index], value: this.app.storage.getVersionedRecord(namespace, id, {
          fields: checkpointMetadataFields,
          paths: { partial: ['manifest', 'partial'] },
          mapStats: { files: { path: ['manifest', 'files'], sumFields: ['size'] } },
        }).then(record => {
          const value = record.value as Pick<WorkspaceCheckpoint, typeof checkpointMetadataFields[number]> & { partial: boolean; files: { count: number; size: number } } | null;
          if (!value || value.conversationId !== conversationId) throw new Error('检查点不属于当前对话。');
          entry.revision = record.revision;
          const { files, ...metadata } = value;
          return { ...metadata, fileCount: files.count, size: files.size };
        }).catch(error => {
          if (this.metadataCache.get(id) === entry) this.metadataCache.delete(id);
          throw error;
        }) };
        this.metadataCache.delete(id);
        this.metadataCache.set(id, entry);
        if (this.metadataCache.size > 512) this.metadataCache.delete(this.metadataCache.keys().next().value!);
        cached = entry;
      }
      // 逐条等待，让消息页等请求能在检查点之间进入存储线程；并发读取同一列表共用摘要请求。
      values.push({ ...await cached.value });
    }
    signal?.throwIfAborted();
    return values.sort((a, b) => a.timestamp - b.timestamp);
  }
  async summaries(actorId: string, conversationId: string, includeInactive = false) {
    const checkpoints = await this.listMetadata(actorId, conversationId);
    // 定位存档只需要消息身份和时间，正文与附件留在存储线程。
    if (!checkpoints.length) return { checkpoints: [] };
    const history = await this.app.storage.readHistorySelection(conversationId, {
      projection: { fields: ['id', 'role', 'runId', 'timestamp'], omitBinary: true },
    });
    const positions = new Map(history.messages.map((message, index) => [message.id, index]));
    const modelBeforeByRun = new Map<string, WorkspaceCheckpointMetadata[]>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.toolName !== 'model_message' || checkpoint.phase !== 'before' || !checkpoint.runId) continue;
      const group = modelBeforeByRun.get(checkpoint.runId) ?? [];
      group.push(checkpoint);
      modelBeforeByRun.set(checkpoint.runId, group);
    }
    // 旧版“模型消息前”存档错误地绑定上一条消息。按运行 ID 和创建时间
    // 找到真正随后写入的模型消息；若目标消息已删除，保留存档记录但不错误显示在别的消息前。
    const modelBeforePosition = (checkpoint: WorkspaceCheckpointMetadata): number => {
      if (!checkpoint.runId) return -1;
      const group = modelBeforeByRun.get(checkpoint.runId) ?? [];
      const following = group.find(value => value.timestamp > checkpoint.timestamp
        || value.timestamp === checkpoint.timestamp && value.id > checkpoint.id);
      return history.messages.findIndex(message => message.role === 'model'
        && message.runId === checkpoint.runId
        && typeof message.timestamp === 'number'
        && message.timestamp >= checkpoint.timestamp
        && (!following || message.timestamp < following.timestamp));
    };
    return { checkpoints: checkpoints
      .map(value => ({ value, modelPosition: value.toolName === 'model_message' && value.phase === 'before'
        ? modelBeforePosition(value) : -1 }))
      .filter(({ value, modelPosition }) => {
        if (includeInactive) return true;
        if (value.toolName === 'model_message' && value.phase === 'before') return modelPosition >= 0;
        return !value.messageNodeId || positions.has(value.messageNodeId);
      })
      .map(({ value, modelPosition }) => ({ id: value.id, conversationId, timestamp: value.timestamp,
      name: value.name, messageIndex: modelPosition >= 0 ? modelPosition : positions.get(value.messageNodeId ?? '') ?? value.messageIndex, messageNodeId: value.messageNodeId, toolName: value.toolName, phase: value.phase,
      fileCount: value.fileCount, size: value.size,
      manifestVersion: 1, partial: value.partial, isUserMessage: value.toolName === 'user_message', isModelMessage: value.toolName === 'model_message' })) };
  }
  async create(actorId: string, conversationId: string, options: { name?: string; runId?: string; toolName?: string; phase?: 'before' | 'after';
    messageId?: string; affectedPaths?: string[]; signal?: AbortSignal; operation?: CheckpointOperationControl; capturedWorkspace?: WorkspaceDefinition } = {}): Promise<WorkspaceCheckpoint> {
    const signal = options.signal ?? options.operation?.signal;
    signal?.throwIfAborted();
    const current = await this.workspace(actorId, conversationId, ['workspace_read']);
    const workspace = options.capturedWorkspace ?? current;
    if (workspace.id !== current.id) throw new Error('检查点与任务的工作区不一致。');
    const created = await this.app.files.transaction(workspace, async () => {
      signal?.throwIfAborted();
      const state = await this.app.storage.readConversationState(conversationId, [{ namespace: branchNamespace, id: conversationId }]);
      options.operation?.update('scanning');
      const snapshot = await this.scan(workspace, signal, options.affectedPaths, await this.base(actorId, conversationId, workspace, signal));
      const beforeFutureModel = options.toolName === 'model_message' && options.phase === 'before' && !options.messageId;
      const checkpoint: WorkspaceCheckpoint = { id: randomUUID(), conversationId, workspaceId: workspace.id, directory: workspace.directory,
        timestamp: Date.now(), name: options.name, toolName: options.toolName ?? 'manual', phase: options.phase ?? 'after', runId: options.runId,
        messageIndex: options.messageId ? state.history.messages.findIndex(message => message.id === options.messageId)
          : beforeFutureModel ? state.history.total : Math.max(0, state.history.total - 1),
        messageNodeId: options.messageId ?? (beforeFutureModel ? undefined : state.history.messages.at(-1)?.id), manifest: snapshot.manifest, contentIds: { ...snapshot.reused } };
      const branches = readBranches(state);
      // 工具结果属于前一条模型节点；检查点与分支绑定在发布清单的同一事务提交。
      let position = checkpoint.messageIndex;
      while (position >= 0 && state.history.messages[position]?.isFunctionResponse) position--;
      const node = branches.graph.nodes[state.history.messages[position]?.id ?? ''];
      if (node) {
        checkpoint.messageNodeId = node.id; checkpoint.messageIndex = position;
        node.workspaceCheckpointId = checkpoint.id; node.workspaceState = 'checkpointed';
      }
      const records: RecordMutation[] = snapshot.files.map(file => {
        const id = `${checkpoint.id}-${fileHash(Buffer.from(file.path))}`;
        checkpoint.contentIds[file.path] = id;
        return { namespace: contentsNamespace, id, ownerId: conversationId, expectedRevision: null, value: file.bytes };
      });
      try {
        // 内容先以不可变记录保存，最后一次事务发布清单；未发布内容不会出现在检查点列表中。
        for (let offset = 0; offset < records.length; offset += 200) {
          (options.signal ?? options.operation?.signal)?.throwIfAborted();
          options.operation?.update('saving', offset, records.length);
          await this.app.storage.commitRecords(records.slice(offset, offset + 200));
        }
        (options.signal ?? options.operation?.signal)?.throwIfAborted();
        options.operation?.commit();
        await this.app.storage.commitConversation({ conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
          ...(options.runId ? { activeRunId: options.runId } : {}), records: [
            { namespace, id: checkpoint.id, ownerId: conversationId, expectedRevision: null, value: checkpoint },
            ...(node ? [branchMutation(state, branches)] : [])] });
      } catch (error) {
        if (await this.app.storage.getRecord(namespace, checkpoint.id)) { this.latest.set(conversationId, checkpoint.id); return checkpoint; }
        for (let offset = 0; offset < records.length; offset += 200)
          await this.app.storage.commitRecords(records.slice(offset, offset + 200).map(record => ({ namespace: record.namespace, id: record.id, delete: true })));
        throw error;
      }
      this.latest.set(conversationId, checkpoint.id);
      this.app.publish({ type: 'workspace.checkpoint.changed', conversationId });
      return checkpoint;
    }, { signal });
    // 清理自身也需要文件锁，必须等创建释放锁后再执行。
    try { await this.prune(actorId, conversationId, signal); }
    catch (error) { if (!signal?.aborted) this.app.publish({ type: 'workspace.checkpoint.warning', runId: options.runId, error: String(error) }); }
    return created;
  }
  private async plan(workspace: WorkspaceDefinition, checkpoint: WorkspaceCheckpoint, transaction: FileTransaction, signal?: AbortSignal) {
    if (workspace.id !== checkpoint.workspaceId) throw new Error('WORKSPACE_MISMATCH: 检查点不属于当前工作区。');
    const available = workspaceSnapshotRoots(workspace);
    const roots = checkpoint.manifest.roots.map(recorded => {
      const root = available.find(item => item.id === recorded.id && path.relative(item.fsPath, fileURLToPath(recorded.uri)) === '');
      if (!root) throw new Error('WORKSPACE_MISMATCH: 检查点所属目录已变化，请重新对应旧目录。');
      return root;
    });
    if (!roots.length) throw new Error('WORKSPACE_MISMATCH: 检查点没有目录信息。');
    // 只扫描该检查点记录的目录；后来加入的目录不进入删除预览和恢复范围。
    const current = await this.scan({ ...workspace, directory: roots[0].fsPath, roots: roots.map(root => ({ name: root.name, directory: root.fsPath })) }, signal);
    const relative = (file: string) => {
      const parsed = parseWorkspaceScopedPath(file, roots);
      return workspaceFilePath(workspace, path.join(parsed.root.fsPath, parsed.relativePath));
    };
    const currentHashes = Object.fromEntries(Object.entries(current.manifest.files).map(([key, value]) => [key, value.hash]));
    // 即使新忽略规则不再扫描目标文件，也必须检查其当前磁盘状态。
    for (const file of [...Object.keys(checkpoint.manifest.files), ...checkpoint.manifest.absentPaths]) {
      const value = await transaction.capture(relative(file));
      if (value.bytes !== null) currentHashes[file] = md5(value.bytes);
    }
    const protectedPaths = new Set(checkpoint.manifest.excluded.map(item => item.path));
    const plan = computeRestorePlan({ checkpointsDir: '', roots, protectedScopedPaths: protectedPaths,
      deletableScopedPaths: new Set(Object.keys(checkpoint.manifest.files)) }, [], {
      fileHashes: Object.fromEntries(Object.entries(checkpoint.manifest.files).map(([key, value]) => [key, value.hash])),
      emptyDirs: checkpoint.manifest.emptyDirs, partial: checkpoint.manifest.partial,
    }, currentHashes, current.manifest.emptyDirs);
    // absent 是实际采集得到的不存在状态，不能用“未扫描到”替代。
    const absent = checkpoint.manifest.absentPaths.filter(file => currentHashes[file] && !isProtectedScopedPath(file, protectedPaths));
    const deletable = [...new Set([...plan.toDelete, ...plan.deletedInSnapshot, ...absent])];
    const untracked = plan.untrackedToDelete.filter(file => !deletable.includes(file));
    const fingerprint = fileHash(Buffer.from(JSON.stringify({ hashes: Object.entries(currentHashes).sort(), dirs: [...current.manifest.emptyDirs].sort() })));
    return { current, plan, deletable, untracked, fingerprint, relative };
  }
  async preview(actorId: string, conversationId: string, checkpointId: string) {
    const workspace = await this.workspace(actorId, conversationId, ['workspace_read']);
    const checkpoint = await this.get(actorId, conversationId, checkpointId);
    const dirtyFiles = this.app.files.dirtyPaths(workspace.id);
    if (dirtyFiles.length) return { success: false, restored: 0, deleted: 0, skipped: 0, dirtyFiles, previewId: undefined, untrackedPaths: [] as string[],
      error: 'DOCUMENT_DIRTY: 请先保存或放弃编辑器中未保存的内容，再预览恢复。' };
    return this.app.files.transaction(workspace, async transaction => {
      const value = await this.plan(workspace, checkpoint, transaction);
      const id = randomUUID();
      for (const [key, preview] of this.previews) if (Date.now() - preview.createdAt > 600_000) this.previews.delete(key);
      this.previews.set(id, { id, actorId, checkpointId, fingerprint: value.fingerprint, createdAt: Date.now() });
      return { success: true, previewId: id, workspaceStateFingerprint: value.fingerprint,
        restored: value.plan.added.length + value.plan.modified.length, deleted: value.deletable.length, skipped: value.plan.skipped,
        deletablePaths: value.deletable.map(value.relative), untrackedPaths: [...value.untracked, ...value.plan.untrackedEmptyDirs].map(value.relative),
        unbackedPaths: checkpoint.manifest.excluded, dirtyFiles: this.app.files.dirtyPaths(workspace.id) };
    });
  }
  async restore(actorId: string, conversationId: string, checkpointId: string, options: {
    previewId?: string; deleteUntrackedFiles?: boolean; operation?: CheckpointOperationControl;
    confirmedDiscardDirty?: boolean; confirmedDirtyFiles?: string[];
  } = {}, change?: PreparedConversationChange) {
    const workspace = await this.workspace(actorId, conversationId, ['workspace_write']);
    const checkpoint = await this.get(actorId, conversationId, checkpointId);
    try { return await this.app.files.transaction(workspace, async transaction => {
      const state = change?.state ?? await this.app.storage.readConversationState(conversationId);
      options.operation?.update('scanning');
      const value = await this.plan(workspace, checkpoint, transaction, options.operation?.signal);
      const preview = options.previewId ? this.previews.get(options.previewId) : undefined;
      if (options.deleteUntrackedFiles && !preview) throw new Error('STALE_RESTORE_PREVIEW: 删除未跟踪文件前需要预览确认。');
      if (options.previewId && (!preview || preview.actorId !== actorId || preview.checkpointId !== checkpointId ||
        preview.fingerprint !== value.fingerprint || Date.now() - preview.createdAt > 600_000)) throw new Error('STALE_RESTORE_PREVIEW: 工作区已变化，请重新预览。');
      const changes: FileChange[] = [];
      for (const file of [...value.plan.added, ...value.plan.modified]) {
        options.operation?.signal.throwIfAborted();
        options.operation?.update('preparing', changes.length, value.plan.added.length + value.plan.modified.length);
        const bytes = await this.app.storage.getRecord(contentsNamespace, checkpoint.contentIds[file]) as Uint8Array | null;
        if (!(bytes instanceof Uint8Array) || md5(bytes) !== checkpoint.manifest.files[file].hash) throw new Error('检查点文件内容缺失或校验失败。');
        changes.push({ path: value.relative(file), before: await transaction.capture(value.relative(file)),
          after: { bytes, hash: fileHash(bytes), mode: checkpoint.manifest.files[file].mode } });
      }
      for (const file of [...value.deletable, ...(options.deleteUntrackedFiles ? value.untracked : [])])
        changes.push({ path: value.relative(file), before: await transaction.capture(value.relative(file)), after: { bytes: null, hash: null } });
      const directories: DirectoryChange[] = [];
      for (const directory of value.plan.targetEmptyDirs) {
        const relative = value.relative(directory);
        if (!await transaction.directoryExists(relative)) directories.push({ path: relative, before: false, after: true });
      }
      if (options.deleteUntrackedFiles) for (const directory of value.plan.untrackedEmptyDirs)
        directories.push({ path: value.relative(directory), before: true, after: false });
      // 旧版允许父根和嵌套根重复记录同一文件。内容一致时合并，不一致时不能猜测采用哪一份。
      const uniqueChanges = new Map<string, FileChange>();
      for (const change of changes) {
        const key = process.platform === 'win32' ? change.path.toLowerCase() : change.path;
        const previous = uniqueChanges.get(key);
        if (previous && (previous.after.hash !== change.after.hash || previous.after.mode !== change.after.mode))
          throw new Error('检查点对同一个文件记录了不同内容，无法自动恢复。');
        uniqueChanges.set(key, change);
      }
      const uniqueDirectories = new Map(directories.map(directory => [process.platform === 'win32' ? directory.path.toLowerCase() : directory.path, directory]));
      options.operation?.commit();
      const operation = await this.app.changes.perform(transaction, workspace, state, [...uniqueChanges.values()], change?.commit ?? {}, { messageId: checkpoint.messageNodeId }, [...uniqueDirectories.values()]);
      if (preview) this.previews.delete(preview.id);
      this.app.productUi.conversations.clearMetadataCache();
      this.app.publish({ type: 'conversation.changed', conversationId });
      return { success: true, restored: [...uniqueChanges.values()].filter(item => item.after.bytes !== null).length,
        deleted: [...uniqueChanges.values()].filter(item => item.after.bytes === null).length, skipped: value.plan.skipped, operationId: operation.id };
    }, { rejectDirty: true, ...(options.confirmedDiscardDirty === true ? { discardDirtyFiles: options.confirmedDirtyFiles ?? [] } : {}) });
    } catch (error) {
      const failure = error as Error & { code?: string; dirtyFiles?: string[] };
      if (failure.dirtyFiles) return { success: false, dirtyFiles: failure.dirtyFiles, error: failure.code, restored: 0, deleted: 0, skipped: 0 };
      throw error;
    }
  }
  private async checkpointReferences(conversationId: string) {
    const state = await this.app.storage.readConversationState(conversationId, [{ namespace: branchNamespace, id: conversationId }]);
    const branch = state.records.find(item => item.namespace === branchNamespace)?.record.value as BranchState | undefined;
    if (branch && !validate(branch.graph).valid) throw new Error('分支记录损坏，无法确认检查点引用，未删除。');
    const nodes = Object.values(branch?.graph.nodes ?? {});
    const messageIds = new Set([...state.history.messages.map(message => message.id), ...nodes.map(node => node.id)]);
    const checkpointIds = new Set(nodes.map(node => node.workspaceCheckpointId));
    return Object.assign((checkpoint: Pick<WorkspaceCheckpoint, 'id' | 'messageNodeId'>) =>
      Boolean(checkpoint.messageNodeId && messageIds.has(checkpoint.messageNodeId)) || checkpointIds.has(checkpoint.id),
      { historyRevision: state.history.revision, branchRevision: state.records.find(item => item.namespace === branchNamespace)?.record.revision ?? null });
  }
  /**
   * A1：删除单个检查点（含不再被引用的内容记录）。
   *
   * 引用保护：检查点仍被当前历史或任意分支引用时拒绝（分支切换 chat-and-workspace
   * 靠它定位恢复点），除非 force。后续检查点会沿用未变化文件的内容记录，因此只删除
   * 同一对话其他检查点都不再引用的内容。删除与恢复共用 files.transaction（workspace-mutations
   * 串行），与创建及 Diff 审阅落盘（changes.write 同经该事务）互斥。
   */
  async delete(actorId: string, conversationId: string, checkpointId: string, options: { force?: boolean } = {}) {
    const result = await this.deleteBatch(actorId, conversationId, [checkpointId], options);
    if (!result.deletedIds.includes(checkpointId)) throw new Error(result.error ?? '检查点不属于当前对话。');
    return { success: true, id: checkpointId };
  }
  async deleteBatch(actorId: string, conversationId: string, checkpointIds: string[], options: { force?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const workspace = await this.workspace(actorId, conversationId, ['workspace_write']);
    return this.app.files.transaction(workspace, async () => {
      const result = { deletedIds: [] as string[], rejectedIds: [] as string[], error: undefined as string | undefined };
      const metadata = await this.listMetadata(actorId, conversationId, options.signal);
      const byId = new Map(metadata.map(checkpoint => [checkpoint.id, checkpoint]));
      let referenced = options.force ? undefined : await this.checkpointReferences(conversationId);
      const candidates: WorkspaceCheckpointMetadata[] = [];
      for (const id of new Set(checkpointIds)) {
        const checkpoint = byId.get(id);
        if (!checkpoint || referenced?.(checkpoint)) {
          result.rejectedIds.push(id);
          result.error = checkpoint ? '检查点仍被历史或分支引用，未删除。' : '检查点不属于当前对话。';
        } else candidates.push(checkpoint);
      }
      if (!candidates.length) return result;
      const selected = new Set(candidates.map(checkpoint => checkpoint.id));
      const contentsById = new Map<string, string[]>();
      const references = new Map<string, number>();
      // 同一批删除只读取一遍内容索引，不保留完整文件清单，也不为每个存档重建共享集合。
      for (const checkpoint of metadata) {
        options.signal?.throwIfAborted();
        const record = await this.app.storage.getVersionedRecord(namespace, checkpoint.id, { fields: ['contentIds'] });
        const value = record.value as Pick<WorkspaceCheckpoint, 'contentIds'> | null;
        const ids = [...new Set(Object.values(value?.contentIds ?? {}))];
        for (const id of ids) references.set(id, (references.get(id) ?? 0) + 1);
        if (selected.has(checkpoint.id)) contentsById.set(checkpoint.id, ids);
      }
      for (const checkpoint of candidates) {
        options.signal?.throwIfAborted();
        try {
          this.app.workspace(actorId, workspace.id, ['workspace_write']);
          if (referenced) {
            const [history, [branchRevision]] = await Promise.all([
              this.app.storage.historyInfo(conversationId),
              this.app.storage.recordRevisions([{ namespace: branchNamespace, id: conversationId }]),
            ]);
            if (history.revision !== referenced.historyRevision || branchRevision !== referenced.branchRevision)
              referenced = await this.checkpointReferences(conversationId);
            if (referenced(checkpoint)) throw new Error('检查点仍被历史或分支引用，未删除。');
          }
          const ids = contentsById.get(checkpoint.id) ?? [];
          const unshared = ids.filter(id => references.get(id) === 1);
          // 先移除存档入口并回收首批内容；中途退出最多留下待清理内容，不保留无法恢复的存档。
          await this.app.storage.commitRecords([{ namespace, id: checkpoint.id, delete: true },
            ...unshared.slice(0, 199).map(id => ({ namespace: contentsNamespace, id, delete: true as const }))]);
          for (const id of ids) references.set(id, references.get(id)! - 1);
          if (this.latest.get(conversationId) === checkpoint.id) this.latest.delete(conversationId);
          this.metadataCache.delete(checkpoint.id);
          result.deletedIds.push(checkpoint.id);
          for (let offset = 199; offset < unshared.length; offset += 200)
            await this.app.storage.commitRecords(unshared.slice(offset, offset + 200).map(id => ({ namespace: contentsNamespace, id, delete: true })));
        } catch (error) {
          if (result.deletedIds.includes(checkpoint.id)) this.app.publish({ type: 'workspace.checkpoint.warning', conversationId, error: String(error) });
          else { result.rejectedIds.push(checkpoint.id); result.error = String(error); }
        }
      }
      if (result.deletedIds.length) this.app.publish({ type: 'workspace.checkpoint.changed', conversationId });
      return result;
    }, { signal: options.signal });
  }
  /**
   * A1：按配置 maxCheckpoints 保留最近的检查点，多余从最旧开始清理。
   * 被历史引用的跳过（计入 skipped），不硬删。create 成功后自动调用一次。
   */
  async prune(actorId: string, conversationId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const max = this.app.product.runtimeSettings().getCheckpointConfig().maxCheckpoints;
    if (!Number.isSafeInteger(max) || max <= 0) return { deleted: 0, skipped: 0 };
    const values = await this.listMetadata(actorId, conversationId, signal);
    const overflow = values.length - max;
    if (overflow <= 0) return { deleted: 0, skipped: 0 };
    // 同一批清理只读取一次引用集合，不能为每个受保护存档反复加载长历史和完整快照。
    // 真正删除时仍在文件锁内重读引用，保留并发新增历史或分支的保护。
    let referenced: Awaited<ReturnType<WorkspaceCheckpoints['checkpointReferences']>>;
    try { referenced = await this.checkpointReferences(conversationId); }
    catch { signal?.throwIfAborted(); return { deleted: 0, skipped: overflow }; }
    signal?.throwIfAborted();
    const candidates = values.slice(0, overflow).filter(value => !referenced(value));
    if (!candidates.length) return { deleted: 0, skipped: overflow };
    const result = await this.deleteBatch(actorId, conversationId, candidates.map(checkpoint => checkpoint.id), { signal });
    return { deleted: result.deletedIds.length, skipped: overflow - result.deletedIds.length };
  }
}
