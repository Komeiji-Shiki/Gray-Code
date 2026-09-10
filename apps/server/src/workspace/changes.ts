import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import type { ConversationCommit, ConversationState, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformStorage, ToolContext } from '@graycode/core';
import { WorkspaceFiles } from './files';
import { fileHash, type DirectoryChange, type FileChange, type FileTransaction } from './fileTransaction';

export const operationNamespace = 'workspace-operations';
export const changeNamespace = 'workspace-changes';
export interface WorkspaceOperation {
  id: string; conversationId: string; workspace: WorkspaceDefinition; createdAt: number;
  runId?: string; toolCallId?: string; messageId?: string; changes: FileChange[];
  directories?: DirectoryChange[];
  writeGrants?: ToolContext['fileWriteGrants'];
}
export type RequestedFileChange = { path: string; expectedHash: string | null } &
  ({ text: string | null; bytes?: never } | { bytes: Uint8Array; text?: never });

/** SQLite 与文件系统不能共用事务；先保存恢复记录，成功后原子提交对话与操作结果。 */
export class WorkspaceChanges {
  constructor(private readonly storage: PlatformStorage, private readonly files: WorkspaceFiles) {}

  private async taskState(context: ToolContext) {
    if (!context.workspace || !context.conversationId || !context.toolCallId) throw new Error('文件操作缺少任务上下文。');
    context.signal.throwIfAborted();
    const run = await this.storage.getRun(context.runId);
    if (!run || run.conversationId !== context.conversationId || run.actorId !== context.actorId || run.workspaceId !== context.workspace.id)
      throw new Error('文件操作不属于当前任务。');
    return this.storage.readConversationState(context.conversationId);
  }
  async directories(context: ToolContext, paths: string[]): Promise<void> {
    if (!context.workspace) throw new Error('请先选择工作区。');
    await this.files.transaction(context.workspace, async transaction => {
      const state = await this.taskState(context);
      const directories: DirectoryChange[] = [];
      for (const directory of paths) if (!await transaction.directoryExists(directory)) directories.push({ path: directory, before: false, after: true });
      await this.perform(transaction, context.workspace!, state, [], {}, { runId: context.runId, toolCallId: context.toolCallId, writeGrants: context.fileWriteGrants }, directories);
    }, { writeGrants: context.fileWriteGrants });
  }
  async removePaths(context: ToolContext, paths: string[]): Promise<void> {
    if (!context.workspace) throw new Error('请先选择工作区。');
    await this.files.transaction(context.workspace, async transaction => {
      const state = await this.taskState(context);
      const changes: FileChange[] = []; const directories: DirectoryChange[] = [];
      const root = await this.files.resolve(context.workspace!, '.');
      const visit = async (file: string): Promise<void> => {
        context.signal.throwIfAborted();
        const absolute = await this.files.resolveGranted(context.workspace!, file, context.fileWriteGrants, true);
        if (absolute === root) throw new Error('不能删除工作区根目录。');
        const info = await lstat(absolute);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          for (const entry of await readdir(absolute)) await visit(path.join(file, entry));
          directories.push({ path: file, before: true, after: false });
        } else changes.push({ path: file, entryOnly: true, before: await transaction.capture(file, true), after: { bytes: null, hash: null } });
      };
      for (const file of paths) await visit(file);
      await this.perform(transaction, context.workspace!, state, changes, {}, { runId: context.runId, toolCallId: context.toolCallId, writeGrants: context.fileWriteGrants }, directories);
    }, { writeGrants: context.fileWriteGrants });
  }

  async write(context: ToolContext, requested: RequestedFileChange[], records?: ConversationCommit['records']): Promise<{ operationId: string; hashes: Record<string, string | null> }> {
    if (!context.workspace || !context.conversationId || !context.toolCallId) throw new Error('文件工具缺少经过认证的任务上下文。');
    const workspace = context.workspace;
    return this.files.transaction(workspace, async transaction => {
      context.signal.throwIfAborted();
      const run = await this.storage.getRun(context.runId);
      if (!run || run.conversationId !== context.conversationId || run.actorId !== context.actorId || run.workspaceId !== workspace.id)
        throw new Error('文件操作不属于当前任务。');
      const state = await this.storage.readConversationState(context.conversationId!);
      const changes: FileChange[] = [];
      for (const request of requested) {
        const before = await transaction.capture(request.path);
        if (before.hash !== request.expectedHash) throw new Error(`FILE_CONFLICT: ${request.path} 已变化。`);
        const bytes = request.bytes !== undefined ? request.bytes : request.text === null ? null : Buffer.from(request.text);
        changes.push({ path: request.path, before, after: { bytes, hash: bytes === null ? null : fileHash(bytes), mode: before.mode } });
      }
      context.signal.throwIfAborted();
      const operation = await this.perform(transaction, workspace, state, changes, { records }, { runId: context.runId, toolCallId: context.toolCallId, writeGrants: context.fileWriteGrants });
      return { operationId: operation.id, hashes: Object.fromEntries(changes.map(change => [change.path, change.after.hash])) };
    }, { writeGrants: context.fileWriteGrants });
  }

  async perform(transaction: FileTransaction, workspace: WorkspaceDefinition, state: ConversationState, changes: FileChange[],
    commit: Pick<ConversationCommit, 'messages' | 'metadata' | 'records' | 'snapshot'> = {},
    identity: Pick<WorkspaceOperation, 'runId' | 'toolCallId' | 'messageId' | 'writeGrants'> = {}, requestedDirectories: DirectoryChange[] = []): Promise<WorkspaceOperation> {
    const directoryMap = new Map(requestedDirectories.map(item => [item.path, item]));
    for (const file of [...changes.filter(item => item.after.bytes !== null).map(item => path.dirname(item.path)),
      ...requestedDirectories.filter(item => item.after).map(item => item.path)]) {
      let directory = file;
      while (directory !== '.' && directory !== path.dirname(directory) && !await transaction.directoryExists(directory)) {
        directoryMap.set(directory, { path: directory, before: false, after: true });
        directory = path.dirname(directory);
      }
    }
    const directories = [...directoryMap.values()].sort((a, b) => a.path.length - b.path.length);
    const operation: WorkspaceOperation = { id: randomUUID(), conversationId: state.metadata.id, workspace: structuredClone(workspace),
      createdAt: Date.now(), changes, directories, ...identity };
    const base = { conversationId: state.metadata.id, expectedRevision: state.history.revision,
      expectedMetadataToken: state.metadataToken, ...(identity.runId ? { activeRunId: identity.runId } : {}) };
    // 取得持久互斥权时再次检查历史和活跃任务；尚未写文件。
    await this.storage.commitConversation({ ...base, records: [{ namespace: operationNamespace, id: state.metadata.id,
      expectedRevision: null, ownerId: state.metadata.id, value: operation }] });
    try {
      await transaction.applyDirectories(directories.filter(item => item.after));
      await transaction.apply(changes);
      await transaction.applyDirectories(directories.filter(item => !item.after).reverse());
      await this.storage.commitConversation({ ...base, ...commit, workspaceOperationId: operation.id,
        records: [...(commit.records ?? []), { namespace: changeNamespace, id: operation.id, ownerId: state.metadata.id, value: operation },
          { namespace: operationNamespace, id: state.metadata.id, expectedRevision: 1, delete: true }] });
      return operation;
    } catch (error) {
      try {
        // 返回丢失时先核实提交结果；已提交的操作绝不能再次回滚。
        const pending = await this.storage.getRecord(operationNamespace, state.metadata.id) as WorkspaceOperation | null;
        if (!pending) return operation;
        if (pending.id !== operation.id) throw new Error('操作记录已被替换。');
        await this.rollback(transaction, operation);
        await this.storage.commitRecords([{ namespace: operationNamespace, id: state.metadata.id, expectedRevision: 1, delete: true }]);
      } catch (recoveryError) {
        this.files.blockWrites(String(recoveryError));
        throw new Error(`WORKSPACE_RECOVERY_REQUIRED: 文件操作中断，恢复记录已保留。${String(recoveryError)}`);
      }
      throw error;
    }
  }

  private async rollback(transaction: FileTransaction, operation: WorkspaceOperation): Promise<void> {
    const undo: FileChange[] = [];
    for (const change of [...operation.changes].reverse()) {
      const current = await transaction.capture(change.path, change.entryOnly);
      if (current.hash === change.before.hash) continue;
      if (current.hash !== change.after.hash) throw new Error(`FILE_CONFLICT: ${change.path} 在中断后发生变化，未覆盖该文件。`);
      undo.push({ path: change.path, entryOnly: change.entryOnly, before: current, after: change.before });
    }
    await transaction.apply(undo);
    for (const directory of [...(operation.directories ?? [])].reverse()) {
      const current = await transaction.directoryExists(directory.path);
      if (current !== directory.before) await transaction.applyDirectories([{ path: directory.path, before: current, after: directory.before }]);
    }
  }

  async recover(): Promise<{ recovered: string[]; conflicts: { operationId: string; error: string }[] }> {
    const result = { recovered: [] as string[], conflicts: [] as { operationId: string; error: string }[] };
    for (const id of await this.storage.listRecords(operationNamespace)) {
      const operation = await this.storage.getRecord(operationNamespace, id) as WorkspaceOperation;
      try {
        await this.files.transaction(operation.workspace, async transaction => {
          const pending = await this.storage.getRecord(operationNamespace, id) as WorkspaceOperation | null;
          if (!pending) return;
          if (pending.id !== operation.id) throw new Error('恢复前操作记录已变化。');
          await this.rollback(transaction, pending);
          await this.storage.commitRecords([{ namespace: operationNamespace, id, expectedRevision: 1, delete: true }]);
          result.recovered.push(operation.id);
        }, { recovery: true, writeGrants: operation.writeGrants });
      } catch (error) { result.conflicts.push({ operationId: operation.id, error: String(error) }); }
    }
    this.files.blockWrites(result.conflicts.length ? result.conflicts.map(item => item.error).join('\n') : undefined);
    return result;
  }
}
