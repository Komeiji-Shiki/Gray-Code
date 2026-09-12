import { normalizePendingApprovalGate } from '../../../../backend/modules/conversation/pendingApprovalGate';
import { randomUUID } from 'node:crypto';
import type { SavedRunConfiguration, RecordMutation, RunRecord, VersionedRecord } from '@graycode/contracts';
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

/** 后台结果与启动标记同属对话事务，重启不重复建立已经开始的模型任务。 */
export class BackgroundContinuation {
  private ready = false;
  private closing = false;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly app: PlatformApplication) {}
  async initialize(): Promise<void> {
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
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.start(conversationId)).catch(error => {
      this.app.publish({ type: 'notification', severity: 'error', message: `后台结果自动继续失败：${String(error)}` });
    });
    this.queues.set(conversationId, operation);
    void operation.finally(() => {
      if (this.queues.get(conversationId) === operation) this.queues.delete(conversationId);
      this.app.publish({ type: 'background.followup.changed', conversationId });
    });
  }
  private async pending(conversationId: string) {
    const result: Array<{ record: VersionedRecord; value: BackgroundFollowup }> = [];
    for (const id of await this.app.storage.listRecords(pendingNamespace, conversationId)) {
      const record = await this.app.storage.getVersionedRecord(namespace, id);
      const value = record.value as BackgroundFollowup | null;
      if (value?.status === 'pending') result.push({ record, value });
    }
    return result.sort((a, b) => a.value.createdAt - b.value.createdAt);
  }
  async consume(run: RunRecord): Promise<void> {
    const pending = await this.pending(run.conversationId);
    if (!pending.length) return;
    const state = await this.app.storage.readConversationState(run.conversationId);
    const records: RecordMutation[] = pending.flatMap(({ record, value }) => [{ namespace: pendingNamespace, id: value.id, delete: true }, { namespace, id: value.id,
      ownerId: run.conversationId, expectedRevision: record.revision,
      value: { ...value, status: state.history.messages.some(message => message.id === value.id) ? 'delivered' : 'obsolete', runId: run.id } }] as RecordMutation[]);
    await this.app.storage.commitConversation({ conversationId: run.conversationId, expectedRevision: state.history.revision,
      expectedMetadataToken: state.metadataToken, activeRunId: run.id, records });
  }
  private async start(conversationId: string, retry = true): Promise<void> {
    if (this.closing || (await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 })).length) return;
    const pending = await this.pending(conversationId);
    if (!pending.length) return;
    const latest = pending.at(-1)!.value;
    let records: RecordMutation[] = [];
    try {
      const state = await this.app.storage.readConversationState(conversationId);
      if (normalizePendingApprovalGate((state.metadata.custom as Record<string, unknown> | undefined)?.pendingApprovalGate)) return;
      const live = pending.filter(({ value }) => state.history.messages.some(message => message.id === value.id));
      if (!live.length) {
        await this.app.storage.commitRecords(pending.flatMap(({ record, value }) => [{ namespace: pendingNamespace, id: value.id, delete: true }, { namespace, id: value.id,
          ownerId: conversationId, expectedRevision: record.revision, value: { ...value, status: 'obsolete' } }] as RecordMutation[]));
        return;
      }
      const source = live.at(-1)!.value;
      let origin = source.sourceRunId ? await this.app.storage.getRun(source.sourceRunId) : null;
      if (origin?.conversationId !== conversationId || origin.actorId !== source.actorId)
        origin = (await this.app.storage.listRuns({ conversationId, actorId: source.actorId, limit: 1 }))[0] ?? null;
      if (!origin && !source.parentConfiguration) throw new Error('原任务配置不可用，结果已保留，请在对话中选择模型后继续。');
      const configuration = source.parentConfiguration?.configuration ?? await this.app.storage.getRecord('run-configurations', origin!.id) as SavedRunConfiguration | null;
      if (!configuration) throw new Error('旧任务未保存模型选择，结果已保留，请在对话中选择模型后继续。');
      const automationId = origin?.automationId ?? configuration.automationId;
      if (automationId) { await this.app.automations.wake(automationId); return; }
      const { workspace: capturedWorkspace, ...selection } = configuration;
      const scope = Object.hasOwn(configuration, 'workspace') ? { workspace: capturedWorkspace ?? undefined } : undefined;
      await this.app.conversation(source.actorId, conversationId);
      const actor = this.app.actor(source.actorId);
      if (!actor || actor.revoked) throw new Error('原发起账号已撤销，未自动继续。');
      const requestKey = `background:${randomUUID()}`;
      records = pending.flatMap(({ record, value }) => [{ namespace: pendingNamespace, id: value.id, delete: true }, { namespace, id: value.id, ownerId: conversationId,
        expectedRevision: record.revision, value: { ...value, status: 'started', requestKey } }] as RecordMutation[]);
      // 模型选项继承发起任务；执行权限仍由核心按当前账号、Agent 和工作区重新校验。
      const run = await this.app.runtime.continue({ actorId: source.actorId, conversationId, agentId: source.parentConfiguration?.agentId ?? origin!.agentId,
        workspaceId: scope ? capturedWorkspace?.id : origin?.workspaceId, ...(actor.role === 'owner' ? selection : {}), requestKey, expectedRevision: state.history.revision }, { state, commit: { records } }, scope);
      this.app.productUi.chat.followBackground(run);
      this.app.publish({ type: 'conversation.changed', runId: run.id, conversationId });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (retry && ['REVISION_CONFLICT', 'STORAGE_BUSY'].includes(code ?? '')) return this.start(conversationId, false);
      // 已建立的运行不由交付器重试；模型失败保留为正常任务错误，交给用户继续。
      await this.app.storage.commitRecords(pending.flatMap(({ record, value }) => [{ namespace: pendingNamespace, id: value.id, delete: true }, { namespace, id: value.id, ownerId: conversationId,
        expectedRevision: record.revision, value: { ...value, status: 'failed', error: String(error) } }] as RecordMutation[]));
      this.app.publish({ type: 'notification', severity: 'error', message: `后台结果已保存，自动继续失败：${String(error)}` });
      this.app.publish({ type: 'conversation.changed', conversationId, ...(latest.sourceRunId ? { runId: latest.sourceRunId } : {}) });
    }
  }
  hasPendingWork(): boolean { return this.queues.size > 0; }
  async hasPending(conversationId: string): Promise<boolean> { return (await this.app.storage.listRecords(pendingNamespace, conversationId)).length > 0; }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled(this.queues.values()); }
}
