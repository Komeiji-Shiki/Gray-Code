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
import { collectWorkspaceSnapshot, type WorkspaceSnapshot, type WorkspaceSnapshotManifest } from './snapshot';
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
interface RestorePreview { id: string; actorId: string; checkpointId: string; fingerprint: string; createdAt: number }
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

export class WorkspaceCheckpoints {
  private readonly previews = new Map<string, RestorePreview>();
  constructor(private readonly app: PlatformApplication) {}
  private async workspace(actorId: string, conversationId: string, effects: ('workspace_read' | 'workspace_write')[]): Promise<WorkspaceDefinition> {
    const conversation = await this.app.conversation(actorId, conversationId);
    if (typeof conversation.workspaceId !== 'string') throw new Error('对话没有绑定工作区。');
    return this.app.workspace(actorId, conversation.workspaceId, effects);
  }
  private scan(workspace: WorkspaceDefinition, signal = new AbortController().signal, affectedPaths?: string[]) {
    return collectWorkspaceSnapshot({ workspace, config: this.app.product.runtimeSettings().getCheckpointConfig(),
      dataDirectory: this.app.storage.directory, signal, affectedPaths });
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
  async summaries(actorId: string, conversationId: string, includeInactive = false) {
    await this.app.conversation(actorId, conversationId);
    const history = await this.app.storage.readFullHistory(conversationId);
    const positions = new Map(history.messages.map((message, index) => [message.id, index]));
    return { checkpoints: (await this.list(actorId, conversationId))
      .filter(value => includeInactive || !value.messageNodeId || positions.has(value.messageNodeId))
      .map(value => ({ id: value.id, conversationId, timestamp: value.timestamp,
      name: value.name, messageIndex: positions.get(value.messageNodeId ?? '') ?? value.messageIndex, messageNodeId: value.messageNodeId, toolName: value.toolName, phase: value.phase,
      fileCount: Object.keys(value.manifest.files).length, size: Object.values(value.manifest.files).reduce((sum, file) => sum + file.size, 0),
      manifestVersion: 1, partial: value.manifest.partial, isUserMessage: value.toolName === 'user_message', isModelMessage: value.toolName === 'model_message' })) };
  }
  async create(actorId: string, conversationId: string, options: { name?: string; runId?: string; toolName?: string; phase?: 'before' | 'after';
    messageId?: string; affectedPaths?: string[]; signal?: AbortSignal; operation?: CheckpointOperationControl; capturedWorkspace?: WorkspaceDefinition } = {}): Promise<WorkspaceCheckpoint> {
    const current = await this.workspace(actorId, conversationId, ['workspace_read']);
    const workspace = options.capturedWorkspace ?? current;
    if (workspace.id !== current.id) throw new Error('检查点与任务的工作区不一致。');
    const created = await this.app.files.transaction(workspace, async () => {
      const state = await this.app.storage.readConversationState(conversationId, [{ namespace: branchNamespace, id: conversationId }]);
      options.operation?.update('scanning');
      const snapshot = await this.scan(workspace, options.signal ?? options.operation?.signal, options.affectedPaths);
      const checkpoint: WorkspaceCheckpoint = { id: randomUUID(), conversationId, workspaceId: workspace.id, directory: workspace.directory,
        timestamp: Date.now(), name: options.name, toolName: options.toolName ?? 'manual', phase: options.phase ?? 'after', runId: options.runId,
        messageIndex: options.messageId ? state.history.messages.findIndex(message => message.id === options.messageId) : Math.max(0, state.history.total - 1),
        messageNodeId: options.messageId ?? state.history.messages.at(-1)?.id, manifest: snapshot.manifest, contentIds: {} };
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
        if (await this.app.storage.getRecord(namespace, checkpoint.id)) return checkpoint;
        for (let offset = 0; offset < records.length; offset += 200)
          await this.app.storage.commitRecords(records.slice(offset, offset + 200).map(record => ({ namespace: record.namespace, id: record.id, delete: true })));
        throw error;
      }
      this.app.publish({ type: 'workspace.checkpoint.changed', conversationId });
      return checkpoint;
    });
    // 清理自身也需要文件锁，必须等创建释放锁后再执行。
    try { await this.prune(actorId, conversationId); }
    catch (error) { this.app.publish({ type: 'workspace.checkpoint.warning', runId: options.runId, error: String(error) }); }
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
  /**
   * A1：删除单个检查点（含其独占的内容记录）。
   *
   * 引用保护：检查点仍被当前历史或任意分支引用时拒绝（分支切换 chat-and-workspace
   * 靠它定位恢复点），除非 force。内容记录 id 含检查点 id 前缀、无跨检查点共享，
   * 可直接随清单删除。删除与恢复共用 files.transaction（workspace-mutations 串行），
   * 与 Diff 审阅落盘（changes.write 同经该事务）天然互斥。
   */
  async delete(actorId: string, conversationId: string, checkpointId: string, options: { force?: boolean } = {}) {
    const workspace = await this.workspace(actorId, conversationId, ['workspace_write']);
    const checkpoint = await this.get(actorId, conversationId, checkpointId);
    return this.app.files.transaction(workspace, async () => {
      if (!options.force) {
        const state = await this.app.storage.readConversationState(conversationId, [{ namespace: branchNamespace, id: conversationId }]);
        const branch = state.records.find(item => item.namespace === branchNamespace)?.record.value as BranchState | undefined;
        if (branch && !validate(branch.graph).valid) throw new Error('分支记录损坏，无法确认检查点引用，未删除。');
        const referenced = (checkpoint.messageNodeId && state.history.messages.some(message => message.id === checkpoint.messageNodeId)) ||
          Object.values(branch?.graph.nodes ?? {}).some(node => node.id === checkpoint.messageNodeId || node.workspaceCheckpointId === checkpointId);
        if (referenced) throw new Error('检查点仍被历史或分支引用，未删除。');
      }
      const contentIds = Object.values(checkpoint.contentIds);
      for (let offset = 0; offset < contentIds.length; offset += 200)
        await this.app.storage.commitRecords(contentIds.slice(offset, offset + 200)
          .map(id => ({ namespace: contentsNamespace, id, delete: true })));
      await this.app.storage.commitRecords([{ namespace, id: checkpoint.id, delete: true }]);
      this.app.publish({ type: 'workspace.checkpoint.changed', conversationId });
      return { success: true, id: checkpoint.id };
    });
  }
  /**
   * A1：按配置 maxCheckpoints 保留最近的检查点，多余从最旧开始清理。
   * 被历史引用的跳过（计入 skipped），不硬删。create 成功后自动调用一次。
   */
  async prune(actorId: string, conversationId: string) {
    const max = this.app.product.runtimeSettings().getCheckpointConfig().maxCheckpoints;
    if (!Number.isSafeInteger(max) || max <= 0) return { deleted: 0, skipped: 0 };
    const values = await this.list(actorId, conversationId);
    const overflow = values.length - max;
    if (overflow <= 0) return { deleted: 0, skipped: 0 };
    let deleted = 0; let skipped = 0;
    for (const value of values.slice(0, overflow)) {
      try { await this.delete(actorId, conversationId, value.id); deleted++; }
      catch { skipped++; }
    }
    return { deleted, skipped };
  }
}
