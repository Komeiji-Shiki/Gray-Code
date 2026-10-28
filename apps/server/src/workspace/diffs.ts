import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { DiffReviewSession } from '../../../../backend/tools/file/DiffReviewSession';
import { encodeTextBytes, type TextDetectionResult } from '../../../../backend/tools/search/textEncodingRuntime';
import { countDeletedLines } from '../../../../backend/core/services/diff/diffAlgorithm';
import { splitLines } from '../../../../backend/core/services/diff/lineId';
import { t } from '../../../../backend/i18n';
import { getErrorDisplayMetadata, type ToolErrorDisplayMetadata } from '../../../../shared/toolErrorMetadata';
import { memoryRoots } from '../memory/files';
import { inside } from './paths';

export interface WorkspaceDiff extends ToolErrorDisplayMetadata {
  runId?: string;
  id: string; conversationId: string; workspaceId: string; path: string; originalText: string; proposedText: string;
  baseHash: string | null; status: 'pending' | 'accepted' | 'rejected' | 'cancelled'; toolCallId: string; createdAt: number;
  operationId?: string; error?: string;
  encoding?: TextDetectionResult;
  diffGuardWarning?: string; diffGuardDeletePercent?: number;
}
export type WorkspaceDiffSummary = Pick<WorkspaceDiff, 'id' | 'conversationId' | 'workspaceId' | 'path' | 'status'
  | 'toolCallId' | 'createdAt' | 'error' | 'displayErrorCode' | 'diffGuardWarning' | 'diffGuardDeletePercent'>;
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
    let afterId: string | undefined;
    for (;;) {
      // 已处理提案通常占绝大多数；恢复只读状态，避免展开历史文件的修改前后全文。
      const page = await this.app.storage.readRecordPage(namespace, undefined, {
        afterId, limit: 200, projection: { fields: ['status'] },
      });
      for (const entry of page) {
        if ((entry.value as Pick<WorkspaceDiff, 'status'>).status !== 'pending') continue;
        const value = await this.app.storage.getRecord(namespace, entry.id) as WorkspaceDiff | null;
        if (value?.status !== 'pending') continue;
        value.status = 'cancelled'; value.error = '程序已重启，未自动重放文件修改。';
        await this.save(value);
      }
      if (page.length < 200) break;
      afterId = page.at(-1)!.id;
    }
  }
  private save(value: WorkspaceDiff) {
    return this.app.storage.putRecord({ namespace, id: value.id, ownerId: value.conversationId, value });
  }
  async list(actorId: string, workspaceId: string, includeId?: string): Promise<WorkspaceDiffSummary[]> {
    if (includeId !== undefined && (typeof includeId !== 'string' || !includeId)) throw new Error(t('modules.diff.previewNotFound'));
    if (!workspaceId.startsWith('memory:')) this.app.workspace(actorId, workspaceId, ['workspace_read']);
    let recent: WorkspaceDiffSummary[] = [], included: WorkspaceDiffSummary | undefined, afterId: string | undefined;
    const conversations = new Set<string>();
    for (;;) {
      // 列表只读摘要；正文由已有 content 接口按选中提案读取，不再展开最近百份文件。
      const page = await this.app.storage.readRecordPage(namespace, undefined, { afterId, limit: 200,
        projection: { fields: ['id', 'conversationId', 'workspaceId', 'createdAt', 'path', 'status', 'toolCallId',
          'error', 'displayErrorCode', 'diffGuardWarning', 'diffGuardDeletePercent'] } });
      for (const entry of page) {
        const value = entry.value as WorkspaceDiffSummary;
        if (value.workspaceId !== workspaceId) continue;
        if (!conversations.has(value.conversationId)) {
          await this.app.conversation(actorId, value.conversationId);
          if (workspaceId.startsWith('memory:') && !(await memoryRoots(this.app, actorId, value.conversationId))
            .some(root => workspaceId === `memory:${path.basename(root.directory)}`)) {
            throw new Error('记忆目录不属于当前会话。');
          }
          conversations.add(value.conversationId);
        }
        if (value.id === includeId) included = value;
        recent.push(value);
      }
      recent = recent.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
      if (page.length < 200) break;
      afterId = page.at(-1)!.id;
    }
    if (includeId !== undefined && !recent.some(value => value.id === includeId)) {
      if (!included) throw new Error(t('modules.diff.previewNotFound'));
      // 精确预览历史目标时仍保持列表上限，只替换最旧的一项，不改默认最新列表。
      recent = [...recent.slice(0, 99), included];
    }
    return recent;
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
    const absolutePath = await this.app.files.resolveGranted(context.workspace, file, context.fileWriteGrants);
    const memories = await Promise.all((await memoryRoots(this.app, context.actorId, context.conversationId, context.workspace))
      .map(root => this.app.files.resolveAbsolute(root.directory)));
    const memoryWrite = memories.some(root => inside(root, absolutePath));
    const session = DiffReviewSession.create({ id: value.id, filePath: file, absolutePath,
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
      const applyMode = memoryWrite || context.approvedByToolConfirmation || (config.autoSave && config.autoApplyWithoutDiffView)
        ? 'immediate' : config.autoSave ? 'autoSave' : 'review';
      const waitingForReview = applyMode === 'review' && !context.signal.aborted;
      if (waitingForReview) await context.onDiffReview?.({ diffId: value.id, path: file, status: 'pending' });
      this.notify(value);
      const apply = async () => {
        try { await this.resolve(context.actorId, value.id, true); }
        catch (error) { value.error = String(error); Object.assign(value, getErrorDisplayMetadata(error)); await this.finish(pending, 'rejected'); }
      };
      if (applyMode === 'immediate') await apply();
      else if (applyMode === 'autoSave') session.scheduleAutoSave(config.autoSaveDelay, apply);
      if (context.signal.aborted) abort();
      const result = await completed;
      if (waitingForReview) await context.onDiffReview?.({ diffId: value.id, path: file, status: result.status });
      return result;
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
    if (pending.value.workspaceId.startsWith('memory:')) {
      if (!(await memoryRoots(this.app, actorId, pending.value.conversationId))
        .some(root => pending.value.workspaceId === `memory:${path.basename(root.directory)}`)) throw new Error('记忆目录不属于当前会话。');
    } else this.app.workspace(actorId, pending.value.workspaceId, ['workspace_write']);
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
