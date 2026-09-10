import { BackgroundContinuation, type BackgroundFollowup } from './continuation';
import type { PlatformMessage, RunRecord, RecordMutation, VersionedRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { PlatformSubagent, SubagentParentConfiguration } from './types';
export interface PendingFeedback { id: string; conversationId: string; actorId: string; sequence?: number; sourceRunId?: string; message: PlatformMessage; displayOnly?: boolean; parentConfiguration?: SubagentParentConfiguration }

/** 后台结果先保存到队列，只在主任务模型边界或空闲时追加历史。 */
export class SubagentFeedback {
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly continuation: BackgroundContinuation;
  constructor(private readonly app: PlatformApplication) { this.continuation = new BackgroundContinuation(app); }
  hasPendingWork(): boolean { return this.queues.size > 0 || this.continuation.hasPendingWork(); }
  async initialize(): Promise<void> {
    const conversations = new Set<string>();
    for (const id of await this.app.storage.listRecords('subagent-feedback')) {
      const pending = await this.app.storage.getRecord('subagent-feedback', id) as PendingFeedback | null;
      if (pending) conversations.add(pending.conversationId);
    }
    for (const conversationId of conversations) {
      if (await this.app.storage.getConversation(conversationId)) await this.flush(conversationId);
    }
    await this.continuation.initialize();
  }
  async enqueue(child: PlatformSubagent, response: string): Promise<void> {
    const id = `subagent-${child.taskId ?? child.id}`;
    if (await this.app.storage.getRecord('subagent-deliveries', id)) return;
    const pending: PendingFeedback = { id, conversationId: child.parentConversationId, actorId: child.actorId, sourceRunId: child.parentRunId, parentConfiguration: child.parentConfiguration,
      message: { id, role: 'user', parts: [{ text: `[Background task ${child.status}]\n${child.agentName}\n\n${response}` }],
        timestamp: Date.now(), isUserInput: false, source: 'background_task', backgroundTask: { kind: 'subagent', taskId: child.id, runId: child.id, conversationId: child.parentConversationId, name: child.agentName, status: child.status }, userFeedback: { kind: 'subagent', subagentId: child.id } } };
    await this.enqueueMessage(pending);
  }
  async enqueueMessage(pending: PendingFeedback, records: RecordMutation[] = []): Promise<void> {
    if (await this.app.storage.getRecord('subagent-deliveries', pending.id)) return;
    await this.enqueueMessages([pending], records);
    await this.flush(pending.conversationId);
  }
  /** 队列、发送回执和展示卡片一起提交，投递由已有模型边界完成。 */
  async enqueueMessages(pending: PendingFeedback[], records: RecordMutation[] = []): Promise<void> {
    await this.app.teams.enqueueFeedback(pending, records);
  }
  pendingIds(conversationId: string): Promise<string[]> { return this.app.storage.listRecords('subagent-feedback', conversationId); }
  flush(conversationId: string, activeRun?: RunRecord): Promise<boolean> {
    const queued = (this.queues.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(() => this.deliverCurrent(conversationId, activeRun));
    this.queues.set(conversationId, queued);
    void queued.finally(() => { if (this.queues.get(conversationId) === queued) this.queues.delete(conversationId); }).catch(() => {});
    void queued.then(() => { if (!activeRun) this.continuation.schedule(conversationId); }).catch(() => {});
    return queued;
  }
  private async deliverCurrent(conversationId: string, activeRun?: RunRecord): Promise<boolean> {
    try { return await this.deliver(conversationId, activeRun); }
    catch (error) {
      const code = (error as { code?: string }).code;
      // 只重读一次并发修改后的历史。磁盘、编码或数据库故障直接交给调用者报告。
      if (code === 'REVISION_CONFLICT') return this.deliver(conversationId, activeRun);
      if (code === 'STORAGE_BUSY' && !activeRun &&
        (await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 })).length) return false;
      throw error;
    }
  }
  private async deliver(conversationId: string, activeRun?: RunRecord): Promise<boolean> {
    // 子代理的启动和继续均由其执行服务管理，包含并发席位、暂停和失败策略。
    if (!activeRun && this.app.subagents.isChildConversation(conversationId)) return false;
    if (!activeRun && (await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 })).length) return false;
    const pending: Array<{ record: VersionedRecord; value: PendingFeedback }> = [];
    for (const id of await this.app.storage.listRecords('subagent-feedback', conversationId)) {
      const record = await this.app.storage.getVersionedRecord('subagent-feedback', id);
      if (record.value) pending.push({ record, value: record.value as PendingFeedback });
    }
    if (!pending.length) return false;
    // 新消息使用提交时分配的持久序号；旧存档的原顺序无法补造，排在新增消息之前。
    pending.sort((a, b) => a.value.sequence !== undefined && b.value.sequence !== undefined ? a.value.sequence - b.value.sequence
      : a.value.sequence !== undefined ? 1 : b.value.sequence !== undefined ? -1
      : Number(a.value.message.timestamp ?? 0) - Number(b.value.message.timestamp ?? 0) || a.value.id.localeCompare(b.value.id));
    const state = await this.app.storage.readConversationState(conversationId);
    const messages = [...state.history.messages]; const appended: PlatformMessage[] = [];
    for (const { value } of pending) {
      if (messages.some(message => message.id === value.id)) continue;
      const message = { ...value.message, parentId: messages.at(-1)?.id ?? null, ...(activeRun ? { runId: activeRun.id } : {}) };
      messages.push(message); appended.push(message);
    }
    await this.app.storage.commitConversation({ conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
      ...(activeRun ? { activeRunId: activeRun.id } : {}), messages,
      records: pending.flatMap(({ record, value }) => [
        { namespace: 'subagent-feedback', id: value.id, expectedRevision: record.revision, delete: true },
        { namespace: 'subagent-deliveries', id: value.id, ownerId: conversationId, value: { deliveredAt: Date.now(), sequence: value.sequence } },
        ...(!activeRun && !value.displayOnly ? [{ namespace: 'background-followup-pending', id: value.id, ownerId: conversationId, value: { id: value.id } }, { namespace: 'background-followups', id: value.id, ownerId: conversationId, value: {
          id: value.id, conversationId, actorId: value.actorId, sourceRunId: value.sourceRunId, parentConfiguration: value.parentConfiguration, status: 'pending', createdAt: Date.now(),
        } satisfies BackgroundFollowup }] : []),
      ]) });
    this.app.productUi.conversations.clearMetadataCache();
    if (activeRun) for (const content of appended) this.app.publish({ type: 'message.persisted', runId: activeRun.id, content });
    this.app.publish({ type: 'conversation.changed', conversationId });
    return appended.some(message => pending.some(item => item.value.id === message.id && !item.value.displayOnly));
  }
}
