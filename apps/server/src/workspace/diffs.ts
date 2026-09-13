import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { DiffReviewSession } from '../../../../backend/tools/file/DiffReviewSession';
import { encodeTextBytes, type TextDetectionResult } from '../../../../backend/tools/search/textEncodingRuntime';
import { countDeletedLines } from '../../../../backend/core/services/diff/diffAlgorithm';
import { splitLines } from '../../../../backend/core/services/diff/lineId';

export interface WorkspaceDiff {
  runId?: string;
  id: string; conversationId: string; workspaceId: string; path: string; originalText: string; proposedText: string;
  baseHash: string | null; status: 'pending' | 'accepted' | 'rejected' | 'cancelled'; toolCallId: string; createdAt: number;
  operationId?: string; error?: string;
  encoding?: TextDetectionResult;
  diffGuardWarning?: string; diffGuardDeletePercent?: number;
}
interface PendingReview {
  value: WorkspaceDiff; context: ToolContext; session: DiffReviewSession; processing: boolean;
  settle(value: WorkspaceDiff): void;
}
const namespace = 'workspace-diffs';

/** 预览保存在独立内存模型中；只有接受操作才进入文件事务，不预创建文件。 */
export class WorkspaceDiffs {
  private readonly pending = new Map<string, PendingReview>();
  constructor(private readonly app: PlatformApplication) {}
  private notify(value: WorkspaceDiff): void {
    this.app.publish({ type: 'workspace.diff.changed', workspaceId: value.workspaceId });
    const pendingDiffs = [...this.pending.values()].map(item => ({ id: item.value.id, status: item.value.status,
      filePath: item.value.path, toolId: item.value.toolCallId, writeReady: true, isProcessing: item.processing,
      diffGuardWarning: item.value.diffGuardWarning, diffGuardDeletePercent: item.value.diffGuardDeletePercent }));
    this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'diff.statusChanged',
      data: { pendingDiffs, allProcessed: pendingDiffs.every(item => item.status !== 'pending') } } });
  }
  async initialize(): Promise<void> {
    for (const id of await this.app.storage.listRecords(namespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as WorkspaceDiff;
      if (value.status === 'pending') {
        value.status = 'cancelled'; value.error = '程序已重启，未自动重放文件修改。';
        await this.save(value);
      }
    }
  }
  private save(value: WorkspaceDiff) {
    return this.app.storage.putRecord({ namespace, id: value.id, ownerId: value.conversationId, value });
  }
  async list(actorId: string, workspaceId: string): Promise<WorkspaceDiff[]> {
    this.app.workspace(actorId, workspaceId, ['workspace_read']);
    const values: WorkspaceDiff[] = [];
    for (const id of await this.app.storage.listRecords(namespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as WorkspaceDiff;
      if (value.workspaceId === workspaceId) { await this.app.conversation(actorId, value.conversationId); values.push(value); }
    }
    return values.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
  async content(actorId: string, id: string) {
    const value = await this.app.storage.getRecord(namespace, id) as WorkspaceDiff | null;
    if (!value) {
      const candidates = (await this.app.storage.listRecords('conversation-diffs')).filter(key => key === id || key.endsWith(`:${id}`));
      if (candidates.length !== 1) throw new Error(candidates.length ? '旧 Diff 标识有歧义，需要提供包含对话标识的引用。' : 'Diff 内容不存在。');
      const key = candidates[0]; const conversationId = key.slice(0, key.indexOf(':'));
      await this.app.conversation(actorId, conversationId);
      const legacy = await this.app.storage.getRecord('conversation-diffs', key) as { originalContent: string; newContent: string; filePath: string };
      return { success: true, ...legacy };
    }
    await this.app.conversation(actorId, value.conversationId);
    return { success: true, originalContent: value.originalText, newContent: value.proposedText, filePath: value.path };
  }
  async propose(context: ToolContext, file: string, originalText: string, proposedText: string, baseHash: string | null, encoding?: TextDetectionResult): Promise<WorkspaceDiff> {
    if (!context.workspace || !context.conversationId || !context.toolCallId) throw new Error('Diff 缺少任务身份。');
    context.signal.throwIfAborted();
    const value: WorkspaceDiff = { id: randomUUID(), conversationId: context.conversationId, workspaceId: context.workspace.id,
      path: file, originalText, proposedText, baseHash, encoding, status: 'pending', runId: context.runId, toolCallId: context.toolCallId, createdAt: Date.now() };
    const config = this.app.product.runtimeSettings().getApplyDiffConfig();
    if (config.diffGuardEnabled) {
      const originalLines = splitLines(originalText);
      const removed = originalLines.length ? countDeletedLines(originalLines, splitLines(proposedText)) : 0;
      value.diffGuardDeletePercent = originalLines.length ? Math.round(removed / originalLines.length * 100) : 0;
      if (originalLines.length && value.diffGuardDeletePercent >= config.diffGuardThreshold)
        value.diffGuardWarning = `本次修改删除或替换了 ${removed}/${originalLines.length} 行（${value.diffGuardDeletePercent}%），达到设置的 ${config.diffGuardThreshold}% 警戒值。`;
    }
    const session = DiffReviewSession.create({ id: value.id, filePath: file, absolutePath: await this.app.files.resolveGranted(context.workspace, file, context.fileWriteGrants),
      originalContent: originalText, newContent: proposedText, toolCallId: context.toolCallId,
      diffGuardWarning: value.diffGuardWarning, diffGuardDeletePercent: value.diffGuardDeletePercent });
    let settle!: PendingReview['settle'];
    const completed = new Promise<WorkspaceDiff>(resolve => { settle = resolve; });
    const pending: PendingReview = { value, context, session, settle, processing: false };
    await this.save(value);
    this.pending.set(value.id, pending);
    session.markPresented();
    const abort = () => {
      if (!pending.processing) void this.finish(pending, 'cancelled').catch(error => { value.error = String(error); settle(value); });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      this.notify(value);
      const apply = async () => {
        try { await this.resolve(context.actorId, value.id, true); }
        catch (error) { value.error = String(error); await this.finish(pending, 'rejected'); }
      };
      if (context.approvedByToolConfirmation || (config.autoSave && config.autoApplyWithoutDiffView)) await apply();
      else if (config.autoSave) session.scheduleAutoSave(config.autoSaveDelay, apply);
      if (context.signal.aborted) abort();
      return await completed;
    } finally {
      context.signal.removeEventListener('abort', abort);
      session.clearAutoSave(); this.pending.delete(value.id); this.notify(value);
    }
  }
  private async finish(pending: PendingReview, status: WorkspaceDiff['status']): Promise<void> {
    if (pending.value.status !== 'pending') return;
    pending.value.status = status;
    if (status === 'accepted') pending.session.accept();
    else if (status === 'cancelled') pending.session.cancel();
    else pending.session.reject();
    try { await this.save(pending.value); } finally { pending.settle(pending.value); this.notify(pending.value); }
  }
  async resolve(actorId: string, id: string, accepted: boolean) {
    const pending = this.pending.get(id);
    if (!pending || pending.value.status !== 'pending') throw new Error('DIFF_NOT_PENDING: 此修改已经处理。');
    await this.app.conversation(actorId, pending.value.conversationId);
    this.app.workspace(actorId, pending.value.workspaceId, ['workspace_write']);
    if (pending.processing) throw new Error('DIFF_ALREADY_PROCESSING: 正在处理此修改。');
    pending.processing = true; this.notify(pending.value);
    try {
      if (accepted) {
        const result = await this.app.changes.write(pending.context, [{ path: pending.value.path,
          ...(pending.value.encoding ? { bytes: encodeTextBytes(pending.value.proposedText, pending.value.encoding) }
            : { text: pending.value.proposedText }), expectedHash: pending.value.baseHash }], [{ namespace, id: pending.value.id,
            ownerId: pending.value.conversationId, value: { ...pending.value, status: 'accepted' } }]);
        pending.value.operationId = result.operationId;
      }
      await this.finish(pending, accepted ? 'accepted' : 'rejected');
      return { success: true, sessionId: id, status: pending.value.status };
    } finally {
      pending.processing = false; this.notify(pending.value);
      if (pending.context.signal.aborted && pending.value.status === 'pending') await this.finish(pending, 'cancelled');
    }
  }
}
