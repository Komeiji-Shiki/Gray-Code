import { randomUUID } from 'node:crypto';
import type { AutomationCreate, AutomationOptions, AutomationRecord, AutomationUsage, RunRecord } from '@graycode/contracts';
import type { ModelInput } from '@graycode/contracts';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import { normalizePendingApprovalGate } from '../../../../backend/modules/conversation/pendingApprovalGate';
import type { PlatformApplication } from '../application';
import { AutomationModelMeter } from './meter';
import { nextScheduledTime, validateSchedule } from './schedule';

export const automationNamespace = 'automations';
const emptyUsage = (): AutomationUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, estimatedRequests: 0, unknownRequests: 0 });

/** 自动任务只负责触发与进度；会话、执行、审批、工具和结果仍由现有运行器持有。 */
export class ApplicationAutomations {
  private readonly records = new Map<string, AutomationRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private closing = false;
  private readonly unsubscribe: () => void;
  readonly meter: AutomationModelMeter;
  constructor(private readonly app: PlatformApplication) {
    this.meter = new AutomationModelMeter({ read: id => this.read(id), add: (id, delta) => this.mutate(id, record => {
      for (const key of Object.keys(delta) as Array<keyof AutomationUsage>) record.usage[key] += delta[key];
    }).then(() => {}) });
    this.unsubscribe = app.subscribe(notification => {
      if (!this.ready || this.closing) return;
      if (notification.type === 'conversation.changed' && typeof notification.conversationId === 'string'
        && [...this.records.values()].some(record => record.conversationId === notification.conversationId))
        void this.removeDeletedConversation(notification.conversationId).catch(error => this.reportError(error));
      const run = notification.type === 'run.created' ? notification.run as RunRecord : undefined;
      if (run) void this.created(run).catch(error => this.reportError(error));
      const event = notification.type === 'event' ? notification.event as { type: string; runId: string } : undefined;
      if (event && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type))
        void this.finished(event.runId).catch(error => this.reportError(error));
    });
  }
  private reportError(error: unknown) { this.app.publish({ type: 'notification', severity: 'error', message: `自动任务处理失败：${String(error)}` }); }
  private async removeDeletedConversation(conversationId: string) {
    if (await this.app.storage.getConversation(conversationId)) return;
    for (const record of this.records.values()) if (record.conversationId === conversationId) this.records.delete(record.id);
    this.arm(); this.app.publish({ type: 'automation.changed', conversationId });
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try { return await next; } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
      this.arm(); this.app.publish({ type: 'automation.changed', ...(this.records.has(id) ? { automationId: id } : {}) });
    }
  }
  private async read(id: string): Promise<AutomationRecord | null> {
    return this.app.storage.getRecord(automationNamespace, id) as Promise<AutomationRecord | null>;
  }
  private changed(record: AutomationRecord) {
    this.records.set(record.id, record); this.arm();
  }
  private async mutate(id: string, operation: (record: AutomationRecord) => void | Promise<void>) {
    return this.serial(id, async () => {
      const stored = await this.app.storage.getVersionedRecord(automationNamespace, id);
      if (!stored.value) throw new Error('自动任务已移除。');
      const record = structuredClone(stored.value) as AutomationRecord;
      await operation(record); record.updatedAt = Date.now();
      await this.app.storage.commitRecords([{ namespace: automationNamespace, id, ownerId: record.conversationId, expectedRevision: stored.revision, value: record }]);
      this.changed(record); return record;
    });
  }
  get keepsAlive() { return [...this.records.values()].some(record => record.status === 'active') || this.queues.size > 0; }
  private arm() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.ready || this.closing) return;
    const due = [...this.records.values()].filter(record => record.status === 'active' && !record.currentRequestKey && record.nextRunAt !== undefined);
    if (!due.length) return;
    const delay = Math.max(1000, Math.min(30_000, Math.min(...due.map(record => record.nextRunAt!)) - Date.now()));
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(error => this.reportError(error)).finally(() => this.arm()); }, delay);
    this.timer.unref();
  }
  async initialize() {
    for (const id of await this.app.storage.listRecords(automationNamespace)) {
      const record = await this.read(id); if (record) this.records.set(id, record);
    }
    for (const record of [...this.records.values()]) {
      if (record.status === 'completed' && !record.currentRequestKey) continue;
      const previous = record.currentRequestKey ? await this.app.storage.getRunByRequestKey(record.currentRequestKey) : null;
      await this.mutate(record.id, current => {
        // 旧预算不再生效，之前暂停的任务仍按重启规则等待手动继续。
        delete (current as AutomationRecord & { tokenBudget?: number }).tokenBudget;
        if ((current.pauseReason as string) === 'budget') current.pauseReason = 'restart';
        if (current.currentRequestKey) {
          current.lastRunId = previous?.id ?? current.lastRunId;
          if (previous?.status === 'completed') current.completedRuns++;
          else if (current.kind === 'schedule') { current.status = 'paused'; current.pauseReason = 'restart'; current.error = '上次运行在应用退出时中断，请确认结果后手动继续。'; }
          delete current.currentRequestKey; delete current.currentRunId;
        }
        delete current.finishRunId; delete current.finishStatus;
        if (current.kind === 'goal' && current.status === 'active') { current.status = 'paused'; current.pauseReason = 'restart'; }
        if (current.kind === 'schedule' && current.status === 'active' && current.schedule) {
          if (previous?.status === 'completed') current.nextRunAt = nextScheduledTime(current.schedule, Date.now());
          else if (current.nextRunAt !== undefined && current.nextRunAt < Date.now() && current.missedRunPolicy === 'skip') current.nextRunAt = nextScheduledTime(current.schedule, Date.now());
          if (current.nextRunAt === undefined && !current.awaitingBackground) { current.status = 'completed'; current.completedAt = Date.now(); }
          if (current.awaitingBackground) { current.status = 'paused'; current.pauseReason = 'restart'; }
        }
      });
    }
    this.ready = true; this.arm();
  }
  async list(actorId: string) {
    this.app.requireOwner(actorId);
    const ids = await this.app.storage.listRecords(automationNamespace);
    for (const id of this.records.keys()) if (!ids.includes(id)) this.records.delete(id);
    const rows = await Promise.all(ids.map(async id => {
      const record = await this.read(id); if (!record) return null;
      const run = record.currentRequestKey ? await this.app.storage.getRunByRequestKey(record.currentRequestKey) : null;
      return { ...record, ...(run ? { currentRunId: run.id, runStatus: run.status } : {}) };
    }));
    this.arm(); return rows.filter((row): row is NonNullable<typeof row> => !!row).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async options(actorId: string, conversationId?: string): Promise<AutomationOptions> {
    this.app.requireOwner(actorId);
    const settings = this.app.settings.snapshot().settings;
    const conversation = conversationId ? await this.app.conversation(actorId, conversationId) : undefined;
    const custom = conversation?.custom as { inputModelConfig?: { configId: string; modelId: string; reasoningEffort?: string }; promptModeConfig?: { modeId: string }; platformMode?: 'chat' | 'code' | 'character' } | undefined;
    const runtime = this.app.product.runtimeSettings();
    const providers = (await Promise.all(settings.providers.map(async profile => (await this.app.product.channel(profile.id))?.enabled ? profile : null)))
      .filter((profile): profile is NonNullable<typeof profile> => !!profile);
    const providerId = custom?.inputModelConfig?.configId ?? runtime.getActiveChannelId() ?? '';
    return { agents: settings.agents.map(({ id, name }) => ({ id, name })), providers,
      workspaces: settings.workspaces.filter(workspace => !workspace.managedConversationId), promptModes: runtime.getAllPromptModes().map(({ id, name }) => ({ id, name })),
      current: { conversationId, workspaceId: conversation?.workspaceId as string | undefined, agentId: settings.agents[0]?.id ?? '', providerId,
        modelId: custom?.inputModelConfig?.modelId ?? providers.find(profile => profile.id === providerId)?.model ?? '', reasoningEffort: custom?.inputModelConfig?.reasoningEffort,
        promptModeId: custom?.promptModeConfig?.modeId ?? settings.modeProfiles?.[custom?.platformMode ?? 'chat']?.promptModeId ?? runtime.getCurrentPromptModeId() } };
  }
  async create(actorId: string, input: AutomationCreate) {
    return this.serial('create', () => this.createRecord(actorId, input));
  }
  private async createRecord(actorId: string, input: AutomationCreate) {
    this.app.requireOwner(actorId);
    if (!['goal', 'schedule'].includes(input.kind) || typeof input.objective !== 'string' || !input.objective.trim()) throw new Error('请填写需要执行的目标或任务。');
    const channel = await this.app.product.channel(input.providerId);
    if (!channel?.enabled) throw new Error('请选择已启用的模型渠道。');
    const agent = this.app.settings.snapshot().settings.agents.find(agent => agent.id === input.agentId);
    if (!agent) throw new Error('智能体不存在。');
    const schedule = input.kind === 'schedule' ? validateSchedule(input.schedule!) : undefined;
    if (schedule && !['skip', 'once'].includes(input.missedRunPolicy ?? '')) throw new Error('请选择错过触发时间后跳过还是补一次。');
    const first = schedule ? nextScheduledTime(schedule, Date.now() - 1) : Date.now();
    if (first === undefined) throw new Error('请选择未来的执行时间。');
    const name = input.name?.trim() || input.objective.trim().split('\n')[0].slice(0, 80);
    const conversation = input.conversationId ? await this.app.conversation(actorId, input.conversationId)
      : await this.app.createConversation(actorId, name, input.workspaceId, { platformMode: 'chat', ...(input.promptModeId ? { promptModeConfig: { modeId: input.promptModeId } } : {}) }, undefined, { automaticWorkspace: true });
    if ([...this.records.values()].some(record => record.conversationId === conversation.id && record.status !== 'completed')) throw new Error('这个对话已有一个未完成的自动任务，请先完成或移除。');
    const workspace = conversation.workspaceId ? this.app.workspace(actorId, String(conversation.workspaceId), []) : undefined;
    const custom = conversation.custom as { promptModeConfig?: { modeId: string }; platformMode?: 'chat' | 'code' | 'character' } | undefined;
    const promptModeId = input.promptModeId ?? custom?.promptModeConfig?.modeId ?? this.app.settings.snapshot().settings.modeProfiles?.[custom?.platformMode ?? 'chat']?.promptModeId
      ?? agent.promptModeId ?? this.app.product.runtimeSettings().getCurrentPromptModeId();
    const now = Date.now();
    const record: AutomationRecord = { version: 1, id: randomUUID(), kind: input.kind, name, objective: input.objective.trim(), conversationId: conversation.id,
      actorId, agentId: input.agentId, status: 'active', createdAt: now, updatedAt: now, usage: emptyUsage(), completedRuns: 0,
      configuration: { providerId: input.providerId, modelOverride: input.modelOverride || channel.model, reasoningEffort: input.reasoningEffort,
        promptModeId, workspace: workspace ?? null }, nextRunAt: first, ...(schedule ? { schedule, missedRunPolicy: input.missedRunPolicy } : {}) };
    await this.app.storage.commitRecords([{ namespace: automationNamespace, id: record.id, ownerId: conversation.id, expectedRevision: null, value: record }]);
    this.changed(record); return record;
  }
  async update(actorId: string, id: string, input: AutomationCreate) {
    this.app.requireOwner(actorId);
    if (typeof input.objective !== 'string' || !input.objective.trim()) throw new Error('请填写任务目标。');
    const channel = await this.app.product.channel(input.providerId);
    if (!channel?.enabled || !this.app.settings.snapshot().settings.agents.some(agent => agent.id === input.agentId)) throw new Error('请选择可用的智能体和模型渠道。');
    const schedule = input.kind === 'schedule' ? validateSchedule(input.schedule!) : undefined;
    if (schedule && (!['skip', 'once'].includes(input.missedRunPolicy ?? '') || nextScheduledTime(schedule, Date.now()) === undefined)) throw new Error('请选择未来触发时间及错过时间后的处理方式。');
    return this.mutate(id, async record => {
      if (record.status !== 'paused' || record.currentRequestKey || await this.hasBackground(record)) throw new Error('请先暂停后续执行，并等待或停止当前运行，再编辑任务。');
      if (record.kind !== input.kind) throw new Error('修改任务类型时请新建一个自动任务。');
      if (record.kind === 'goal' && input.objective.trim() !== record.objective) record.pendingObjectiveChange = true;
      record.name = input.name?.trim() || input.objective.trim().split('\n')[0].slice(0, 80);
      record.objective = input.objective.trim(); record.agentId = input.agentId;
      record.configuration = { ...record.configuration, providerId: input.providerId, modelOverride: input.modelOverride || channel.model,
        promptModeId: input.promptModeId || record.configuration.promptModeId, reasoningEffort: input.reasoningEffort || undefined };
      if (schedule) { record.schedule = schedule; record.missedRunPolicy = input.missedRunPolicy; record.nextRunAt = nextScheduledTime(schedule, Date.now()); }
      record.pauseReason = 'user'; record.awaitingBackground = false; record.followupPending = false;
      delete record.error; delete record.finishRunId; delete record.finishStatus;
    });
  }
  async pause(actorId: string, id: string, stopCurrent = false) {
    this.app.requireOwner(actorId);
    const record = await this.mutate(id, current => { current.status = 'paused'; current.pauseReason = 'user'; });
    if (stopCurrent) {
      for (const run of await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })) if (run.automationId === id) await this.app.runtime.cancel(run.id, actorId);
      for (const task of this.app.subagents.backgroundTasks()) if (await this.ownsBackground(record, task.metadata)) await this.app.subagents.cancelTask(actorId, task.id);
    }
    return record;
  }
  async resume(actorId: string, id: string) {
    this.app.requireOwner(actorId);
    return this.mutate(id, async record => {
      if (record.status === 'completed') throw new Error('任务已经完成，可以新建另一个目标。');
      const continueInterrupted = !!record.lastRunId && (record.awaitingBackground || ['error', 'restart', 'input'].includes(record.pauseReason ?? ''));
      record.status = 'active'; delete record.pauseReason; delete record.error; delete record.finishRunId; delete record.finishStatus;
      record.awaitingBackground = false;
      record.nextRunAt = record.kind === 'goal' ? Date.now() : nextScheduledTime(record.schedule!, Date.now());
      if (record.kind === 'schedule' && (continueInterrupted || record.nextRunAt === undefined)) { record.nextRunAt = Date.now(); record.followupPending = !!record.lastRunId; }
    });
  }
  async remove(actorId: string, id: string) {
    await this.pause(actorId, id, true);
    await this.serial(id, async () => {
      await this.app.storage.commitRecords([{ namespace: automationNamespace, id, delete: true }]); this.records.delete(id); this.arm();
      this.app.publish({ type: 'automation.changed', automationId: id });
    });
  }
  async wake(id: string) {
    const existing = await this.read(id); if (!existing || existing.status !== 'active') return;
    await this.mutate(id, record => { if (record.status === 'active') { record.awaitingBackground = false; record.followupPending = true; record.nextRunAt = Date.now(); } });
  }
  async tick(now = Date.now()) {
    if (this.closing || !this.ready) return;
    const due = [...this.records.values()].filter(record => record.status === 'active' && !record.currentRequestKey && record.nextRunAt !== undefined && record.nextRunAt <= now);
    await Promise.all(due.map(record => this.dispatch(record.id, now)));
  }
  private async dispatch(id: string, now: number) {
    await this.serial(id, async () => {
      const stored = await this.app.storage.getVersionedRecord(automationNamespace, id);
      const record = stored.value as AutomationRecord | null;
      if (!record) { this.records.delete(id); return; }
      if (record.status !== 'active' || record.currentRequestKey || record.nextRunAt === undefined || record.nextRunAt > now || this.closing) return;
      if ((await this.app.storage.listRuns({ conversationId: record.conversationId, activeOnly: true, limit: 1 })).length) return;
      try {
        const state = await this.app.conversations.read(record.actorId, record.conversationId);
        if (normalizePendingApprovalGate((state.metadata.custom as Record<string, unknown> | undefined)?.pendingApprovalGate)) {
          record.status = 'paused'; record.pauseReason = 'input'; record.error = '当前对话中的文档正在等待确认，请确认后继续自动任务。';
        } else {
          const requestKey = `automation:${id}:${randomUUID()}`;
          const started = { ...record, currentRequestKey: requestKey, nextRunAt: undefined, followupPending: false, awaitingBackground: false, pendingObjectiveChange: false, updatedAt: Date.now() };
          const { workspace, ...selection } = record.configuration;
          const input = { ...selection, requestKey, actorId: record.actorId, agentId: record.agentId, conversationId: record.conversationId, workspaceId: workspace?.id };
          const change = { state, commit: { records: [{ namespace: automationNamespace, id, ownerId: record.conversationId, expectedRevision: stored.revision, value: started }] } };
          const scope = { workspace: workspace ?? undefined, automationId: id };
          const continuation = !!record.lastRunId && !record.pendingObjectiveChange && (record.kind === 'goal' || record.followupPending);
          const run = continuation ? await this.app.runtime.continue({ ...input, expectedRevision: state.history.revision }, change, scope)
            : await this.app.runtime.start({ ...input, message: { role: 'user', parts: [{ text: record.objective }] } }, change, scope);
          this.changed(started); this.app.productUi.chat.followBackground(run);
          this.app.publish({ type: 'conversation.changed', conversationId: record.conversationId, runId: run.id }); return;
        }
      } catch (error) {
        if (['REVISION_CONFLICT', 'STORAGE_BUSY'].includes((error as { code?: string }).code ?? '')) return;
        record.status = 'paused'; record.pauseReason = 'error'; record.error = error instanceof Error ? error.message : String(error);
      }
      record.updatedAt = Date.now();
      await this.app.storage.commitRecords([{ namespace: automationNamespace, id, ownerId: record.conversationId, expectedRevision: stored.revision, value: record }]); this.changed(record);
    });
  }
  private async created(run: RunRecord) {
    if (run.automationId) {
      const record = await this.read(run.automationId);
      if (record?.currentRequestKey === run.requestKey) await this.mutate(record.id, current => { if (current.currentRequestKey === run.requestKey) current.currentRunId = run.id; });
    } else {
      for (const record of this.records.values()) if (record.status === 'active' && record.conversationId === run.conversationId)
        await this.mutate(record.id, current => { current.status = 'paused'; current.pauseReason = 'user'; current.progress = '主人在此对话中开始了新一轮消息，自动执行已暂停。'; });
    }
  }
  private async hasBackground(record: AutomationRecord) {
    if (await this.app.subagents.feedback.continuation.hasPending(record.conversationId)) return true;
    for (const task of this.app.subagents.backgroundTasks()) if (await this.ownsBackground(record, task.metadata)) return true;
    return false;
  }
  private async ownsBackground(record: AutomationRecord, metadata: { runId: string }) {
    const child = await this.app.subagents.get(record.actorId, metadata.runId);
    const parentId = child && this.app.subagents.rootParentRunId(child);
    return !!child && (parentId ? (await this.app.storage.getRun(parentId))?.automationId === record.id : child.parentConfiguration?.configuration.automationId === record.id);
  }
  private async finished(runId: string) {
    const run = await this.app.storage.getRun(runId); if (!run?.automationId) return;
    const known = await this.read(run.automationId); if (!known || known.currentRequestKey !== run.requestKey) return;
    const record = await this.mutate(known.id, async current => {
      if (current.currentRequestKey !== run.requestKey) return;
      current.lastRunId = run.id; delete current.currentRunId; delete current.currentRequestKey; delete current.followupPending;
      if (run.status === 'completed') current.completedRuns++;
      if (current.status !== 'active') return;
      if (run.status !== 'completed') { current.status = 'paused'; current.pauseReason = run.status === 'cancelled' ? 'user' : 'error'; current.error = run.error; return; }
      if (await this.app.subagents.feedback.continuation.hasPending(current.conversationId)) {
        current.followupPending = true; current.awaitingBackground = false; current.nextRunAt = Date.now(); return;
      }
      if (await this.hasBackground(current)) { current.awaitingBackground = true; delete current.nextRunAt; return; }
      current.nextRunAt = current.kind === 'goal' ? Date.now() + 1000 : nextScheduledTime(current.schedule!, Date.now());
      if (current.nextRunAt === undefined) { current.status = 'completed'; current.completedAt = Date.now(); }
    });
    if (record.status === 'completed' || record.status === 'paused' && record.pauseReason !== 'user') this.app.publish({ type: 'notification',
      severity: record.pauseReason === 'error' ? 'error' : 'info', message: record.status === 'completed' ? `自动任务已完成：${record.name}` : `自动任务已暂停：${record.name}` });
  }
  async preparePrompt<T extends { systemPrompt: string; toolNames: string[]; promptContext?: ModelInput['promptContext'] }>(id: string | undefined, conversationId: string, prepared: T): Promise<T> {
    if (!id) return prepared;
    const record = await this.read(id); if (!record || record.conversationId !== conversationId || record.kind !== 'goal') return prepared;
    return { ...prepared, toolNames: [...new Set([...prepared.toolNames, 'goal_update'])],
      systemPrompt: [prepared.systemPrompt, `\n长期目标：${record.objective}`,
        '持续推进这个目标，保留重要进度。使用 goal_update 报告进展；只有目标已完成时才报告 complete，缺少必须由用户提供的信息时报告 needs_input。普通最终回复不会结束长期目标。',
        record.progress ? `最近进度：${record.progress}` : ''].filter(Boolean).join('\n') };
  }
  tool(): RuntimeTool {
    return { declaration: { name: 'goal_update', description: '记录当前长期目标的进度，或报告目标已完成／必须等待用户信息。仅操作当前目标。',
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['progress', 'complete', 'needs_input'] }, summary: { type: 'string', description: '已经完成的工作、验证结果，或需要用户补充的信息。' } }, required: ['status', 'summary'], additionalProperties: false } },
      effects: () => [], execute: (args, context) => this.progress(context, String(args.status), String(args.summary)) };
  }
  private async progress(context: ToolContext, status: string, summary: string) {
    const run = await this.app.storage.getRun(context.runId);
    if (!run?.automationId) return { success: false, error: '当前运行不属于长期目标。' };
    const record = await this.read(run.automationId);
    if (!record || record.kind !== 'goal' || record.conversationId !== run.conversationId || record.currentRequestKey !== run.requestKey) return { success: false, error: '只能由当前目标的主任务更新进度。' };
    if (!summary.trim()) return { success: false, error: '请填写具体进度。' };
    if (status === 'complete' && await this.hasBackground(record)) return { success: false, error: '还有子任务在运行，请等待结果后再确认目标完成。' };
    const updated = await this.mutate(record.id, current => {
      current.progress = summary.trim();
      if (status !== 'progress') { current.finishRunId = run.id; current.finishStatus = status === 'complete' ? 'completed' : 'paused'; }
    });
    return { success: true, data: { status, progress: updated.progress, usage: updated.usage } };
  }
  async afterTools(run: RunRecord): Promise<{ stop: boolean; reason?: string } | undefined> {
    if (!run.automationId) return;
    const record = await this.read(run.automationId);
    if (!record?.finishRunId || record.finishRunId !== run.id) return;
    await this.mutate(record.id, current => {
      current.status = current.finishStatus ?? 'paused';
      if (current.status === 'completed') current.completedAt = Date.now(); else current.pauseReason = 'input';
      delete current.finishRunId; delete current.finishStatus; delete current.nextRunAt;
    });
    return { stop: true, reason: record.finishStatus === 'completed' ? 'goal_completed' : 'goal_awaiting_input' };
  }
  async close() {
    this.closing = true; this.unsubscribe(); if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await Promise.allSettled(this.queues.values());
  }
}
