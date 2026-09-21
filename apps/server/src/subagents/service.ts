import { randomUUID } from 'node:crypto';
import type { AgentDefinition, PlatformMessage, RunRecord, ToolOutcome, RecordMutation } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { SubAgentConcurrencyLimiter } from '../../../../backend/tools/subagents/concurrencyLimiter';
import { MAX_SUBAGENT_NESTING_DEPTH } from '../../../../backend/tools/subagents/types';
import { DEFAULT_SUBAGENTS_CONFIG } from '../../../../backend/modules/settings/types/subAgentsTypes';
import { SubagentFeedback } from './feedback';
import { PlatformAgentMessages } from './messages';
import type { PlatformSubagent, SubagentLaunchContext } from './types';
import { createSubagentRecord } from './profile';
import { LegacySubagents } from './legacy';
import { getRunContentRange } from '../../../../backend/tools/subagents/eventBus/contentWindow';
import type { SubAgentRunContentWindowOptions } from '../../../../backend/tools/subagents/eventBus/types';

interface LiveSubagent {
  record: PlatformSubagent;
  controller: AbortController;
  done: Promise<ToolOutcome>;
  detached: Promise<ToolOutcome>;
  detach: (result: ToolOutcome) => void;
  acceptingMessages: boolean;
  coreRunId?: string;
  pauseRequested: boolean;
  resume?: () => void;
  retry?: () => void;
  hasSlot: boolean;
}
class SubagentTimeoutError extends Error {}
const namespace = 'platform-subagents';
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);

/** 子任务使用同一核心执行器、权限和文件事务，监视器只投影状态与正文。 */
export class SubagentExecutionService {
  readonly feedback: SubagentFeedback;
  readonly messages: PlatformAgentMessages;
  readonly legacy: LegacySubagents;
  private readonly continuations = new Set<string>();
  private readonly live = new Map<string, LiveSubagent>();
  private readonly records = new Map<string, PlatformSubagent>();
  private readonly byCoreRun = new Map<string, PlatformSubagent>();
  private readonly saves = new Map<string, Promise<unknown>>();
  private readonly limiter: SubAgentConcurrencyLimiter;
  private readonly pendingCompletions = new Set<string>();
  private readonly waitingRuns = new Map<string, { count: number; released: boolean; live?: LiveSubagent }>();
  private events: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private closing = false;
  constructor(private readonly app: PlatformApplication) {
    this.feedback = new SubagentFeedback(app);
    this.messages = new PlatformAgentMessages(app, this);
    this.legacy = new LegacySubagents(app, this);
    this.limiter = new SubAgentConcurrencyLimiter(() => this.config().maxConcurrentAgents);
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed') { this.limiter.onCapacityChanged(); return; }
      if (!['event', 'message.persisted', 'model.delta', 'tool.progress'].includes(String(event.type))) return;
      const completedRunId = event.type === 'event' && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(String((event.event as { type?: string })?.type))
        ? (event.event as { runId: string }).runId : undefined;
      if (completedRunId) this.pendingCompletions.add(completedRunId);
      this.events = this.events.then(() => this.notification(event as Record<string, any>)).catch(error => {
        app.publish({ type: 'notification', message: `子代理状态更新失败：${(error as Error).message}` });
      }).finally(() => {
        if (completedRunId) { this.pendingCompletions.delete(completedRunId); app.publish({ type: 'background.followup.changed' }); }
      });
    });
  }
  hasPendingWork(): boolean { return this.pendingCompletions.size > 0 || this.feedback.hasPendingWork(); }
  private config() { return { ...DEFAULT_SUBAGENTS_CONFIG, ...this.app.product.runtimeSettings().getSubAgentsConfig() }; }
  private save(record: PlatformSubagent): Promise<void> {
    const value = structuredClone(record);
    const saved = (this.saves.get(record.id) ?? Promise.resolve()).catch(() => {}).then(() => this.app.storage.putRecord({ namespace, id: record.id, ownerId: record.parentConversationId, value }));
    this.saves.set(record.id, saved);
    return saved;
  }
  async initialize(): Promise<void> {
    for (const id of await this.app.storage.listRecords(namespace)) {
      const record = await this.app.storage.getRecord(namespace, id) as PlatformSubagent;
      if (!terminal(record.status)) { record.status = 'interrupted'; record.error = '宿主重启，未自动重放子代理操作。'; await this.save(record); }
      this.records.set(record.id, record);
    }
    // 完整恢复父子关系后再接收结果，使嵌套任务沿用同一个主会话序号。
    for (const record of this.records.values()) if (record.background) await this.feedback.enqueue(record, await this.output(record));
  }
  async get(actorId: string, id: string): Promise<PlatformSubagent | null> {
    const record = this.records.get(id) ?? await this.app.storage.getRecord(namespace, id) as PlatformSubagent | null;
    if (!record) return null;
    await this.app.conversation(actorId, record.parentConversationId);
    if (this.app.actor(actorId)?.role !== 'owner' && record.actorId !== actorId) throw new Error('无权访问此子代理运行。');
    this.records.set(id, record); return record;
  }
  /** 会话正文、任务配置及旧运行对应关系一次发布，避免留下半个迁入任务。 */
  async adopt(record: PlatformSubagent, messages: PlatformMessage[] = [], records: RecordMutation[] = []): Promise<void> {
    await this.app.conversation(record.actorId, record.parentConversationId);
    await this.app.storage.initializeConversation({ id: record.conversationId, title: record.agentName, actorId: record.actorId,
      workspaceId: record.workspace?.id, createdAt: record.createdAt, updatedAt: record.updatedAt, parentConversationId: record.parentConversationId,
      custom: { platformSubagentId: record.id, ...(record.legacyOrigin ? { legacySubagent: record.legacyOrigin } : {}) } }, messages,
      [...records, { namespace, id: record.id, ownerId: record.parentConversationId, expectedRevision: null, value: record }]);
    this.records.set(record.id, record);
  }
  async retryLegacy(record: PlatformSubagent, messages: PlatformMessage[], context: SubagentLaunchContext): Promise<void> {
    if (this.live.has(record.id)) throw new Error('请先停止子代理，再重试旧记录。');
    await this.app.conversations.replaceImportedSubagentHistory(context.actorId, record.conversationId, messages);
    record.parentConfiguration = structuredClone(context.parentConfiguration);
    record.profile.toolNames = record.profile.toolNames.filter(name => context.agent.toolNames.includes(name));
    record.background = true; await this.save(record); this.launch(record);
  }
  agent(id: string, actorId?: string, conversationId?: string): AgentDefinition | null {
    const record = [...this.records.values()].find(record => record.profile.id === id);
    if (!record || record.conversationId !== conversationId || !actorId || record.actorId !== actorId && this.app.actor(actorId)?.role !== 'owner') return null;
    return structuredClone(record.profile);
  }
  private manifest(record: PlatformSubagent) {
    return { runId: record.id, sourceToolCallId: record.sourceToolCallId, agentName: record.agentName, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
      conversationId: record.parentConversationId, contentCount: record.contentCount, eventCount: record.eventSequence,
      contentRevision: record.contentRevision, eventSequence: record.eventSequence, canRetry: terminal(record.status) || record.status === 'awaiting_monitor_action',
      ...(record.legacyOrigin ? { continuedFromRunId: record.legacyOrigin.runId } : {}) };
  }
  private emit(record: PlatformSubagent, type: string, payload?: unknown, extra: Record<string, unknown> = {}) {
    record.eventSequence++;
    if (type.startsWith('run_') || type === 'content_snapshot') {
      void this.app.teams.memberChanged(record.conversationId, record.id, `${record.taskId}:${record.status}`, record.status)
        .catch(error => this.app.publish({ type: 'notification', severity: 'error', message: `子代理团队事件保存失败：${String(error)}` }));
    }
    this.app.publish({ type: 'ui.message', message: { type: 'subagentMonitor.event', data: { manifest: this.manifest(record),
      activeRunIds: [...this.live.keys()], event: { runId: record.id, agentName: record.agentName, type, timestamp: Date.now(),
        eventSequence: record.eventSequence, contentRevision: record.contentRevision, payload, ...extra } } } });
  }
  async manifests(actorId: string, conversationId?: string) {
    const values: Array<ReturnType<SubagentExecutionService['manifest']>> = [];
    for (const record of this.records.values()) if (!conversationId || record.parentConversationId === conversationId) {
      if (this.app.actor(actorId)?.role !== 'owner' && record.actorId !== actorId) continue;
      values.push(this.manifest(record));
    }
    return values;
  }
  hasActiveAgent(name: string) { return [...this.live.values()].some(item => item.record.agentName === name); }
  activeIds() { return [...this.live.keys()]; }
  childConversationIds() { return new Set([...this.records.values()].map(record => record.conversationId)); }
  isChildConversation(conversationId: string) { return [...this.records.values()].some(record => record.conversationId === conversationId); }
  recordForRun(run: RunRecord): PlatformSubagent | undefined {
    return [...this.records.values()].find(record => record.profile.id === run.agentId && record.actorId === run.actorId && record.conversationId === run.conversationId);
  }
  acceptsMessages(id: string) { const live = this.live.get(id); return !!live?.acceptingMessages && !live.controller.signal.aborted; }
  stopAcceptingMessages(id: string) { const live = this.live.get(id); if (live) live.acceptingMessages = false; }
  messageParticipants(actorId: string, rootId: string) {
    return [...this.live.values()].filter(live => this.acceptsMessages(live.record.id) && live.record.actorId === actorId
      && this.rootConversationId(live.record.conversationId) === rootId).map(live => live.record);
  }
  async hasTeamProgress(actorId: string, rootId: string, exceptRunId: string): Promise<boolean> {
    const candidates = [...this.live.values()].filter(live => live.record.actorId === actorId && this.acceptsMessages(live.record.id)
      && this.rootConversationId(live.record.conversationId) === rootId && !live.pauseRequested
      && ['queued', 'running'].includes(live.record.status) && live.coreRunId !== exceptRunId
      && (!live.coreRunId || !this.waitingRuns.has(live.coreRunId)));
    for (const live of candidates) {
      if (!live.coreRunId) return true;
      const run = await this.app.storage.getRun(live.coreRunId);
      if (run && ['queued', 'running'].includes(run.status)) return true;
    }
    return (await this.app.storage.listRuns({ conversationId: rootId, activeOnly: true, limit: 10 }))
      .some(run => run.actorId === actorId && run.id !== exceptRunId && !this.waitingRuns.has(run.id) && ['queued', 'running'].includes(run.status));
  }
  /** 同一轮并行工具共享等待计数，最后一个等待结束时才重新取得席位。 */
  async withReleasedSlotWhileWaiting<T>(runId: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const waiting = this.waitingRuns.get(runId) ?? { count: 0, released: false, live: [...this.live.values()].find(live => live.coreRunId === runId) };
    waiting.count++; this.waitingRuns.set(runId, waiting);
    if (waiting.live?.hasSlot) { this.limiter.release(waiting.live.record.id); waiting.live.hasSlot = false; waiting.released = true; }
    try { return await operation(); }
    finally {
      waiting.count--;
      if (!waiting.count) {
        try {
          if (waiting.released && waiting.live && !signal.aborted && !waiting.live.controller.signal.aborted && !this.closing) {
            await this.limiter.acquire(waiting.live.record.id, signal, Number(this.config().queueTimeoutSeconds) * 1000);
            waiting.live.hasSlot = true;
          }
        } finally { this.waitingRuns.delete(runId); }
      }
    }
  }
  private rootRecord(record: PlatformSubagent): PlatformSubagent {
    let current = record;
    for (let depth = 0; depth < MAX_SUBAGENT_NESTING_DEPTH; depth++) {
      const parent = [...this.records.values()].find(item => item.conversationId === current.parentConversationId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }
  rootParentRunId(record: PlatformSubagent) { return this.rootRecord(record).parentRunId; }
  rootParentConfiguration(record: PlatformSubagent) { return this.rootRecord(record).parentConfiguration; }
  async detachToMain(record: PlatformSubagent): Promise<void> {
    let current: PlatformSubagent | undefined = record;
    const changed: PlatformSubagent[] = [];
    while (current) {
      const live = this.live.get(current.id);
      if (live && !current.background) {
        current.background = true; changed.push(current);
        live.detach({ success: true, data: { agentName: current.agentName, runId: current.id, taskId: current.taskId,
          background: true, status: current.status, detached: true, message: '子代理已向主模型发送消息，继续在后台执行。' } });
        this.taskEvent(current, 'start');
      }
      const parentConversationId: string = current.parentConversationId;
      current = [...this.records.values()].find(item => item.conversationId === parentConversationId);
    }
    await Promise.all(changed.map(item => this.save(item)));
  }
  rootConversationId(conversationId: string): string {
    for (let depth = 0; depth < MAX_SUBAGENT_NESTING_DEPTH; depth++) {
      const record = [...this.records.values()].find(record => record.conversationId === conversationId);
      if (!record) break;
      conversationId = record.parentConversationId;
    }
    return conversationId;
  }
  backgroundTasks() {
    return [...this.live.values()].filter(live => live.record.background).map(({ record }) => ({ id: record.taskId!, type: 'background_subagent',
      startTime: record.createdAt, metadata: { conversationId: record.parentConversationId, agentName: record.agentName, runId: record.id, delivery: 'platform_history' } }));
  }
  async cancelTask(actorId: string, taskId: string) {
    const live = [...this.live.values()].find(live => live.record.taskId === taskId);
    return live ? this.control(actorId, live.record.id, 'exit') : { success: false, active: false };
  }
  private taskEvent(record: PlatformSubagent, type: 'start' | 'complete' | 'error' | 'cancelled', response?: string) {
    if (!record.background) return;
    this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'taskEvent', data: { taskId: record.taskId,
      taskType: 'background_subagent', type, createdAt: Date.now(), error: record.error,
      data: { conversationId: record.parentConversationId, agentName: record.agentName, runId: record.id, response, delivery: 'platform_history' } } } });
  }
  async window(actorId: string, id: string, options: SubAgentRunContentWindowOptions = {}) {
    const record = await this.get(actorId, id); if (!record) return null;
    let info = await this.app.storage.historyInfo(record.conversationId);
    const limited = { ...options, limit: Math.min(200, options.limit ?? 20) };
    let range = getRunContentRange(info.total + 1, limited);
    let count = Math.max(0, range.endIndex - Math.max(1, range.startIndex));
    let page = count ? await this.app.storage.readHistory(record.conversationId, { offset: Math.max(0, range.startIndex - 1), limit: count }) : undefined;
    // 读取边界时刚好追加消息，按同一修订号重新取得尾部窗口。
    if (page && page.revision !== info.revision) {
      info = { ...info, revision: page.revision, total: page.total };
      range = getRunContentRange(info.total + 1, limited); count = Math.max(0, range.endIndex - Math.max(1, range.startIndex));
      page = count ? await this.app.storage.readHistory(record.conversationId, { offset: Math.max(0, range.startIndex - 1), limit: count }) : undefined;
    }
    const totalCount = (page?.total ?? info.total) + 1;
    const contents = [...(range.startIndex === 0 && range.endIndex > 0 ? [record.invocation] : []), ...page?.messages ?? []]
      .map((content, index) => ({ ...content, index: range.startIndex + index }));
    const endIndex = range.startIndex + contents.length;
    record.contentRevision = page?.revision ?? info.revision; record.contentCount = totalCount;
    return { manifest: this.manifest(record), activeRunIds: this.activeIds(), window: { runId: id, contents, startIndex: range.startIndex, endIndex, totalCount,
      contentRevision: record.contentRevision, eventSequence: record.eventSequence, contextCompactions: [], hasMoreBefore: range.startIndex > 0, hasMoreAfter: endIndex < totalCount } };
  }
  async requests(actorId: string, id: string) {
    const record = await this.get(actorId, id);
    if (!record) return { approvals: [], questions: [] };
    return { approvals: this.app.runtime.pendingApprovals().filter(item => record.coreRunIds.includes(item.runId)),
      questions: this.app.runtime.pendingQuestions().filter(item => record.coreRunIds.includes(item.runId)) };
  }
  async answer(actorId: string, id: string, requestId: string, response: boolean | string[], choiceId?: string) {
    const requests = await this.requests(actorId, id);
    if (typeof response === 'boolean') {
      if (!requests.approvals.some(item => item.id === requestId)) throw new Error('此审批不属于当前子代理，或已结束。');
      await this.app.runtime.resolveApproval(requestId, actorId, response, choiceId);
    } else {
      if (!requests.questions.some(item => item.id === requestId)) throw new Error('此问题不属于当前子代理，或已结束。');
      await this.app.runtime.answerQuestion(requestId, actorId, response);
    }
    return { success: true };
  }
  async mutate(actorId: string, id: string, index: number, messageId: string | undefined, expectedRevision: number | undefined, retry: boolean) {
    const record = await this.get(actorId, id); if (!record) throw new Error('此运行没有独立任务记录。');
    const live = this.live.get(id);
    if (live && record.status !== 'awaiting_monitor_action') throw new Error('请先停止子代理，再修改其历史或重试。');
    const state = await this.app.storage.readConversationState(record.conversationId);
    const target = state.history.messages[index - 1];
    if (!Number.isSafeInteger(index) || index < 1 || !target || messageId && target.id !== messageId || expectedRevision !== undefined && state.history.revision !== expectedRevision)
      throw new Error('子代理消息已变化，或所选条目是调用说明，请刷新后重试。');
    if (retry) {
      const change = await this.app.conversations.reroll(actorId, record.conversationId, target.id!, `monitor:${randomUUID()}`);
      await this.app.conversations.commit(change);
      if (live) live.retry?.();
      else { record.background = true; this.launch(record); }
    } else {
      await this.app.conversations.remove(actorId, record.conversationId, index - 1, target.id!, true);
      const info = await this.app.storage.historyInfo(record.conversationId);
      record.contentRevision = info.revision; record.contentCount = info.total + 1; await this.save(record); this.emit(record, 'content_snapshot');
    }
    return this.window(actorId, id);
  }
  async removeParent(actorId: string, conversationId: string): Promise<void> {
    await this.app.terminals.removeConversation(conversationId);
    await this.app.conversation(actorId, conversationId);
    for (const record of [...this.records.values()].filter(record => record.parentConversationId === conversationId)) {
      const live = this.live.get(record.id);
      if (live) { live.controller.abort(new Error('所属对话已删除。')); await live.done.catch(() => {}); }
      if (await this.app.storage.getConversation(record.conversationId)) {
        await this.removeParent(actorId, record.conversationId);
        await this.app.storage.deleteConversation(record.conversationId);
      }
      await this.app.storage.commitRecords([{ namespace, id: record.id, delete: true }]);
      this.records.delete(record.id);
      for (const id of record.coreRunIds) this.byCoreRun.delete(id);
    }
  }
  async boundary(run: RunRecord, signal: AbortSignal): Promise<void> {
    const record = this.byCoreRun.get(run.id) ?? [...this.records.values()].find(record => record.profile.id === run.agentId);
    const live = record && this.live.get(record.id);
    if (!live?.pauseRequested) return;
    record!.status = 'paused'; await this.save(record!); this.emit(record!, 'run_paused');
    if (live.pauseRequested) await this.waitAction(live, signal, 'resume');
    record!.status = 'running'; await this.save(record!); this.emit(record!, 'run_resumed');
  }
  private waitAction(live: LiveSubagent, signal: AbortSignal, kind: 'resume' | 'retry'): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => { live[kind] = undefined; reject(signal.reason ?? new Error('子代理已停止。')); };
      live[kind] = () => { signal.removeEventListener('abort', abort); live[kind] = undefined; resolve(); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async dispatch(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const key = typeof args.continueFromRunId === 'string' && args.continueFromRunId ? JSON.stringify([context.conversationId, args.continueFromRunId]) : undefined;
    if (key && this.continuations.has(key)) throw new Error('此子代理已有接续请求正在处理。');
    if (key) this.continuations.add(key);
    try { return await this.dispatchCurrent(args, context); }
    finally { if (key) this.continuations.delete(key); }
  }
  private async dispatchCurrent(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    if (this.closing) throw new Error('子代理服务正在关闭。');
    if (!context.conversationId || !context.agent || !context.modelSelection) throw new Error('子代理缺少经过认证的派发上下文。');
    context.signal.throwIfAborted();
    const parentRun = await this.app.storage.getRun(context.runId);
    if (parentRun?.conversationId !== context.conversationId || parentRun.actorId !== context.actorId) throw new Error('派发不属于当前任务。');
    const parent = this.recordForRun(parentRun);
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_SUBAGENT_NESTING_DEPTH) throw new Error('已达到子代理嵌套深度上限。');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || typeof args.agentName !== 'string') throw new Error('请提供子代理名称和任务。');
    const settings = this.config();
    const background = args.background === true;
    let record: PlatformSubagent;
    if (typeof args.continueFromRunId === 'string' && args.continueFromRunId) {
      let previous = await this.get(context.actorId, args.continueFromRunId);
      const fromLegacy = !previous;
      if (!previous) previous = await this.legacy.continue(args.continueFromRunId, args, context as SubagentLaunchContext, depth);
      if (!previous || previous.parentConversationId !== context.conversationId || !terminal(previous.status)) throw new Error('只能继续当前对话中已结束的独立子代理。');
      if (!fromLegacy && previous.agentName !== args.agentName && !(previous.agentName === 'General Worker' && args.agentName === 'general-worker')) throw new Error('继续运行时须沿用原子代理身份。');
      record = previous; record.sourceToolCallId = context.toolCallId; record.parentRunId = context.runId; record.background = background;
      record.parentConfiguration = undefined;
      record.status = 'queued';
      record.profile.toolNames = record.profile.toolNames.filter(name => context.agent!.toolNames.includes(name));
    } else {
      record = createSubagentRecord(this.app, args, context as SubagentLaunchContext, depth);
      await this.adopt(record);
    }
    const message: PlatformMessage = { role: 'user', parts: [{ text: `${typeof args.context === 'string' && args.context ? `## Context\n${args.context}\n\n` : ''}## Task\n${args.prompt}` }] };
    if (context.signal.aborted) {
      record.status = 'cancelled'; record.error = '派发任务已停止，子代理未启动。'; await this.save(record); this.emit(record, 'run_cancelled');
      context.signal.throwIfAborted();
    }
    const live = this.launch(record, message);
    if (background) return { success: true, data: { agentName: record.agentName, runId: record.id, taskId: record.taskId, background: true, status: 'queued' } };
    const abort = () => { if (!record.background) live.controller.abort(context.signal.reason); };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    try { return await this.withReleasedSlotWhileWaiting(context.runId, context.signal, () => Promise.race([live.done, live.detached])); }
    finally {
      context.signal.removeEventListener('abort', abort);
    }
  }
  private launch(record: PlatformSubagent, message?: PlatformMessage): LiveSubagent {
    if (this.live.has(record.id)) throw new Error('此子代理仍在运行。');
    record.taskId = `${record.id}:${record.coreRunIds.length + 1}`;
    let detach!: (result: ToolOutcome) => void;
    const detached = new Promise<ToolOutcome>(resolve => { detach = resolve; });
    const live: LiveSubagent = { record, controller: new AbortController(), done: Promise.resolve({ success: false }), detached, detach,
      acceptingMessages: true, pauseRequested: false, hasSlot: false };
    this.live.set(record.id, live);
    this.taskEvent(record, 'start');
    live.done = this.execute(live, message).finally(() => { this.live.delete(record.id); this.emit(record, 'run_finished'); });
    void live.done.catch(() => {}); return live;
  }
  private async execute(live: LiveSubagent, initial?: PlatformMessage): Promise<ToolOutcome> {
    const record = live.record; const signal = live.controller.signal;
    const abort = () => { if (live.coreRunId) this.app.runtime.interrupt(live.coreRunId, signal.reason instanceof Error ? signal.reason : new Error('子代理已停止。')); };
    signal.addEventListener('abort', abort);
    try {
      let message = initial;
      for (;;) {
        signal.throwIfAborted(); record.status = 'queued'; record.error = undefined; await this.save(record); this.emit(record, 'run_queued');
        await this.limiter.acquire(record.id, signal, Number(this.config().queueTimeoutSeconds) * 1000); live.hasSlot = true;
        const input = { requestKey: `subagent:${record.id}:${randomUUID()}`, actorId: record.actorId, agentId: record.profile.id, conversationId: record.conversationId,
          workspaceId: (await this.app.storage.getConversation(record.conversationId))?.workspaceId as string | undefined };
        const parent = record.parentRunId ? await this.app.storage.getRun(record.parentRunId) : null;
        const scope = { ...(Object.hasOwn(record, 'workspace') ? { workspace: record.workspace ?? undefined } : {}), modelSelection: record.selection,
          nodeOrigin: parent?.nodeOrigin ?? record.parentConfiguration?.configuration.nodeOrigin,
          automationId: parent?.automationId ?? record.parentConfiguration?.configuration.automationId };
        const run = message ? await this.app.runtime.start({ ...input, message }, undefined, scope)
          : await this.app.runtime.continue({ ...input, expectedRevision: (await this.app.storage.historyInfo(record.conversationId)).revision }, undefined, scope);
        message = undefined; live.coreRunId = run.id; record.coreRunIds.push(run.id); this.byCoreRun.set(run.id, record);
        if (signal.aborted) abort();
        const timeout = record.maxRuntime > 0 ? setTimeout(() => live.controller.abort(new SubagentTimeoutError('子代理超过配置的运行时间。')), record.maxRuntime * 1000) : undefined;
        let finished: RunRecord | null;
        try { finished = await this.app.runtime.wait(run.id); }
        finally { if (timeout) clearTimeout(timeout); this.limiter.release(record.id); live.hasSlot = false; }
        await this.events;
        record.updatedAt = Date.now();
        record.status = finished?.status === 'completed' ? 'completed' : signal.aborted && !(signal.reason instanceof SubagentTimeoutError) ? 'cancelled' : 'failed';
        record.error = finished?.error;
        if (await this.messages.settle(record, record.status === 'completed')) continue;
        if (record.status === 'failed' && record.failureMode === 'wait_for_monitor_action') {
          record.status = 'awaiting_monitor_action'; await this.save(record); this.emit(record, 'run_waiting');
          await this.waitAction(live, signal, 'retry'); live.acceptingMessages = true; continue;
        }
        break;
      }
    } catch (error) { record.status = signal.aborted && !(signal.reason instanceof SubagentTimeoutError) ? 'cancelled' : 'failed'; record.error = (error as Error).message; record.updatedAt = Date.now(); }
    finally { live.acceptingMessages = false; signal.removeEventListener('abort', abort); if (live.hasSlot) this.limiter.release(record.id); }
    await this.save(record); this.emit(record, `run_${record.status}`);
    const response = await this.output(record);
    if (record.background) {
      try { await this.feedback.enqueue(record, response); }
      catch { this.app.publish({ type: 'notification', message: '子代理已结束，结果尚未同步到主对话，可以先从监视器查看。' }); }
      this.taskEvent(record, record.status === 'completed' ? 'complete' : record.status === 'cancelled' ? 'cancelled' : 'error', response);
    }
    return { success: record.status === 'completed', cancelled: record.status === 'cancelled', error: record.error,
      data: { agentName: record.agentName, runId: record.id, response, status: record.status, duration: record.updatedAt - record.createdAt } };
  }
  private async output(record: PlatformSubagent): Promise<string> {
    if (!await this.app.storage.getConversation(record.conversationId)) return record.error || '子代理会话未完成创建。';
    const history = await this.app.storage.readFullHistory(record.conversationId);
    const last = [...history.messages].reverse().find(message => message.role === 'model' && message.parts.some(part => typeof part.text === 'string' && !part.thought));
    return last?.parts.filter(part => !part.thought).map(part => typeof part.text === 'string' ? part.text : '').join('') || record.error || '子代理没有返回正文。';
  }
  private async notification(event: Record<string, any>): Promise<void> {
    const runId = event.runId ?? event.event?.runId;
    if (typeof runId !== 'string') return;
    let record = this.byCoreRun.get(runId);
    if (!record && event.type !== 'event') return;
    if (event.type === 'event') {
      const run = await this.app.storage.getRun(runId); if (!run) return;
      if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event.type)) {
        await this.feedback.flush(run.conversationId);
        this.app.publish({ type: 'conversation.changed', runId: run.id, conversationId: run.conversationId });
      }
      record ??= [...this.records.values()].find(record => record.profile.id === run.agentId);
    }
    if (!record) return; this.byCoreRun.set(runId, record);
    if (event.type === 'model.delta') { this.emit(record, 'llm_delta', { delta: event.parts, done: false }); return; }
    if (event.type === 'message.persisted' || event.type === 'event' && event.event.type === 'run.started') {
      const info = await this.app.storage.historyInfo(record.conversationId); record.contentRevision = info.revision; record.contentCount = info.total + 1;
      if (event.type === 'event') record.status = 'running';
      await this.save(record); this.emit(record, 'content_snapshot', { contentCount: record.contentCount }); return;
    }
    if (event.type === 'event') {
      const source = event.event; const payload = source.payload;
      this.emit(record, source.type.replaceAll('.', '_'), payload, { toolId: payload.toolCallId, toolName: payload.toolName });
    }
  }
  async control(actorId: string, id: string, action: 'pause' | 'resume' | 'exit') {
    const record = await this.get(actorId, id); const live = record && this.live.get(id);
    if (!record || !live) return { success: false, active: false };
    if (action === 'pause') live.pauseRequested = true;
    if (action === 'resume') { live.pauseRequested = false; live.resume?.(); live.retry?.(); }
    if (action === 'exit') live.controller.abort(new Error('主人停止了子代理。'));
    return { success: true, active: action !== 'exit', status: record.status, pending: action === 'pause' && record.status !== 'paused' };
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const live of this.live.values()) live.controller.abort(new Error('宿主正在关闭。'));
    await Promise.allSettled([...this.live.values()].map(live => live.done)); await this.events; this.unsubscribe();
  }
}
