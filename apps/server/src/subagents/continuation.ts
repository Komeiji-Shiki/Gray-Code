import { normalizePendingApprovalGate } from '../../../../backend/modules/conversation/pendingApprovalGate';
import { randomUUID } from 'node:crypto';
import type { SavedRunConfiguration, RecordMutation, RunRecord, VersionedRecord } from '@graycode/contracts';
import { PlatformStorageError } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { SubagentParentConfiguration } from './types';

export interface BackgroundFollowup {
  id: string; conversationId: string; actorId: string; sourceRunId?: string;
  parentConfiguration?: SubagentParentConfiguration;
  status: 'pending' | 'started' | 'delivered' | 'failed' | 'obsolete';
  createdAt: number; requestKey?: string; runId?: string; error?: string;
}
const namespace = 'background-followups';
const pendingNamespace = 'background-followup-pending';
const claimNamespace = 'background-followup-claims';
// 每条结果更新两条记录，另留一条记录原子保存进度或删除认领记录。
const FOLLOWUP_BATCH_SIZE = 127;
type PendingFollowup = { record: VersionedRecord; value: BackgroundFollowup };
interface FollowupClaim { completed: number; entries: Array<{ revision: number | null; value: BackgroundFollowup }> }

/** 后台结果与启动标记同属对话事务，重启不重复建立已经开始的模型任务。 */
export class BackgroundContinuation {
  private ready = false;
  private closing = false;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly app: PlatformApplication) {}
  async initialize(): Promise<void> {
    // 认领记录与运行预约一起提交；先补齐回执，不能把已开始的结果重新发起为模型任务。
    for (const id of await this.app.storage.listRecords(claimNamespace)) await this.serial(id, () => this.settleClaim(id));
    this.ready = true;
    const conversations = new Set<string>();
    for (const id of await this.app.storage.listRecords(pendingNamespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as BackgroundFollowup;
      if (value.status === 'pending') conversations.add(value.conversationId);
    }
    for (const id of conversations) this.schedule(id);
  }
  schedule(conversationId: string): void {
    if (!this.ready || this.closing) return;
    const operation = this.serial(conversationId, () => this.start(conversationId)).catch(error => {
      this.app.publish({ type: 'notification', severity: 'error', message: `后台结果自动继续失败：${String(error)}` });
    });
    void operation.finally(() => {
      this.app.publish({ type: 'background.followup.changed', conversationId });
    });
  }
  private serial<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(conversationId, operation);
    void operation.finally(() => { if (this.queues.get(conversationId) === operation) this.queues.delete(conversationId); }).catch(() => {});
    return operation;
  }
  private claim(conversationId: string, pending: PendingFollowup[], update: (value: BackgroundFollowup) => Partial<BackgroundFollowup>): RecordMutation {
    return { namespace: claimNamespace, id: conversationId, ownerId: conversationId, expectedRevision: null,
      value: { completed: 0, entries: pending.map(({ record, value }) => ({ revision: record.revision, value: { ...value, ...update(value) } })) } satisfies FollowupClaim };
  }
  private async settleClaim(conversationId: string): Promise<void> {
    const record = await this.app.storage.getVersionedRecord(claimNamespace, conversationId);
    const claim = record.value as FollowupClaim | null;
    if (!claim) return;
    let revision = record.revision;
    for (let offset = claim.completed; offset < claim.entries.length; offset += FOLLOWUP_BATCH_SIZE) {
      const end = Math.min(claim.entries.length, offset + FOLLOWUP_BATCH_SIZE);
      const records: RecordMutation[] = claim.entries.slice(offset, end).flatMap(entry => [
        { namespace: pendingNamespace, id: entry.value.id, delete: true },
        { namespace, id: entry.value.id, ownerId: conversationId, expectedRevision: entry.revision, value: entry.value },
      ] as RecordMutation[]);
      records.push(end === claim.entries.length
        ? { namespace: claimNamespace, id: conversationId, expectedRevision: revision, delete: true }
        : { namespace: claimNamespace, id: conversationId, ownerId: conversationId, expectedRevision: revision, value: { ...claim, completed: end } });
      const committed = await this.app.storage.commitRecords(records);
      revision = committed.at(-1)!.revision;
    }
  }
  private async pending(conversationId: string) {
    const result: PendingFollowup[] = [];
    for (const id of await this.app.storage.listRecords(pendingNamespace, conversationId)) {
      const record = await this.app.storage.getVersionedRecord(namespace, id);
      const value = record.value as BackgroundFollowup | null;
      if (value?.status === 'pending') result.push({ record, value });
    }
    return result.sort((a, b) => a.value.createdAt - b.value.createdAt);
  }
  consume(run: RunRecord): Promise<void> {
    return this.serial(run.conversationId, () => this.consumeCurrent(run));
  }
  private async consumeCurrent(run: RunRecord): Promise<void> {
    await this.settleClaim(run.conversationId);
    const pending = await this.pending(run.conversationId);
    if (!pending.length) return;
    const state = await this.app.storage.getConversationInfo(run.conversationId);
    if (!state) throw new PlatformStorageError('NOT_FOUND', `Conversation does not exist: ${run.conversationId}`);
    const history = await this.app.storage.readHistorySelection(run.conversationId, { expectedRevision: state.historyRevision, projection: { fields: ['id'] } });
    const ids = new Set(history.messages.map(message => message.id));
    await this.app.storage.commitConversation({ conversationId: run.conversationId, expectedRevision: state.historyRevision,
      expectedMetadataToken: state.metadataToken, activeRunId: run.id,
      records: [this.claim(run.conversationId, pending, value => ({ status: ids.has(value.id) ? 'delivered' : 'obsolete', runId: run.id }))] });
    await this.settleClaim(run.conversationId);
  }
  private async start(conversationId: string, retry = true): Promise<void> {
    if (this.closing || (await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 })).length) return;
    await this.settleClaim(conversationId);
    const pending = await this.pending(conversationId);
    if (!pending.length) return;
    const latest = pending.at(-1)!.value;
    let started = false;
    try {
      const state = await this.app.storage.readConversationState(conversationId);
      if (normalizePendingApprovalGate((state.metadata.custom as Record<string, unknown> | undefined)?.pendingApprovalGate)) return;
      const ids = new Set(state.history.messages.map(message => message.id));
      const live = pending.filter(({ value }) => ids.has(value.id));
      if (!live.length) {
        await this.app.storage.commitRecords([this.claim(conversationId, pending, () => ({ status: 'obsolete' }))]);
        await this.settleClaim(conversationId);
        return;
      }
      const source = live.at(-1)!.value;
      let origin = source.sourceRunId ? await this.app.storage.getRun(source.sourceRunId) : null;
      if (origin?.conversationId !== conversationId || origin.actorId !== source.actorId)
        origin = (await this.app.storage.listRuns({ conversationId, actorId: source.actorId, limit: 1 }))[0] ?? null;
      if (!origin && !source.parentConfiguration) throw new Error('原任务配置不可用，结果已保留，请在对话中选择模型后继续。');
      if (origin?.status === 'cancelled') {
        // 用户停止优先。迟到的用户/代理输入照常保留历史，但不能借后台回流复活已取消任务。
        await this.app.storage.commitRecords([this.claim(conversationId, pending, () => ({ status: 'obsolete', error: '原任务已取消；输入已保留，等待用户手动继续。' }))]);
        await this.settleClaim(conversationId);
        return;
      }
      const configuration = source.parentConfiguration?.configuration ?? await this.app.storage.getRecord('run-configurations', origin!.id) as SavedRunConfiguration | null;
      if (!configuration) throw new Error('旧任务未保存模型选择，结果已保留，请在对话中选择模型后继续。');
      const automationId = origin?.automationId ?? configuration.automationId;
      if (automationId) { await this.app.automations.wake(automationId); return; }
      const { workspace: capturedWorkspace, nodeOrigin, ...selection } = configuration;
      const captured = Object.hasOwn(configuration, 'workspace');
      const scope = { ...(captured ? { workspace: capturedWorkspace ?? undefined } : {}), nodeOrigin: origin?.nodeOrigin ?? nodeOrigin };
      await this.app.conversation(source.actorId, conversationId);
      const actor = this.app.actor(source.actorId);
      if (!actor || actor.revoked) throw new Error('原发起账号已撤销，未自动继续。');
      const requestKey = `background:${randomUUID()}`;
      const records = [this.claim(conversationId, pending, () => ({ status: 'started', requestKey }))];
      // 模型选项继承发起任务；执行权限仍由核心按当前账号、Agent 和工作区重新校验。
      const run = await this.app.runtime.continue({ actorId: source.actorId, conversationId, agentId: source.parentConfiguration?.agentId ?? origin!.agentId,
        workspaceId: captured ? capturedWorkspace?.id : origin?.workspaceId, ...(actor.role === 'owner' ? selection : {}), requestKey, expectedRevision: state.history.revision }, { state, commit: { records } }, scope);
      started = true;
      await this.settleClaim(conversationId);
      this.app.productUi.chat.followBackground(run);
      this.app.publish({ type: 'conversation.changed', runId: run.id, conversationId });
    } catch (error) {
      if (started) throw error;
      const code = (error as { code?: string }).code;
      if (retry && ['REVISION_CONFLICT', 'STORAGE_BUSY'].includes(code ?? '')) return this.start(conversationId, false);
      // 已建立的运行不由交付器重试；模型失败保留为正常任务错误，交给用户继续。
      await this.app.storage.commitRecords([this.claim(conversationId, pending, () => ({ status: 'failed', error: String(error) }))]);
      await this.settleClaim(conversationId);
      this.app.publish({ type: 'notification', severity: 'error', message: `后台结果已保存，自动继续失败：${String(error)}` });
      this.app.publish({ type: 'conversation.changed', conversationId, ...(latest.sourceRunId ? { runId: latest.sourceRunId } : {}) });
    }
  }
  hasPendingWork(): boolean { return this.queues.size > 0; }
  async hasPending(conversationId: string): Promise<boolean> { return (await this.app.storage.listRecords(pendingNamespace, conversationId)).length > 0; }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled(this.queues.values()); }
}
