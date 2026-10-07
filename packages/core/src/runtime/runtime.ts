import { randomUUID } from 'node:crypto';
import type {
  ActorIdentity, AgentDefinition, ApprovalRequest, ApprovalChoice, ApprovalDecision, ModelProvider, PlatformMessage, RunEvent, RunRecord,
  StartRunInput, ToolEffect, ToolOutcome, WorkspaceDefinition, ModelInput,
  ContinueRunInput, ConversationState, ConversationCommit, PlatformConversation, ModelRequestSnapshot, ModelToolCall,
} from '@graycode/contracts';
import { PlatformStorage } from '../storage/client';
import { RuntimeToolRegistry, authorizeEffects, needsApproval, type ToolCatalog, type ToolContext } from './tools';
import { QuestionBroker } from './questions';
import { normalizeToolArguments } from './toolArguments';
import { DeltaCoalescer } from './deltas';
import { NativeAsyncTools, NATIVE_ASYNC_NAMESPACE, WAIT_FOR_TASKS, nativeToolDeclaration, waitForTasksDeclaration, type NativeToolRecord } from './nativeAsync';

export interface RuntimeServices {
  executionNodeId?: () => string;
  currentNodeOrigin?: () => RunRecord['nodeOrigin'];
  storage: PlatformStorage;
  models: ModelProvider;
  tools: RuntimeToolRegistry;
  /** 按已选渠道捕获声明与执行选项，同一回合内保持稳定。 */
  prepareTools?: (names: string[], input: StartRunInput | ContinueRunInput, agent: AgentDefinition) => Promise<ToolCatalog>;
  actor: (id: string, scope?: RunRecord | Pick<RunRecord, 'conversationId' | 'workspaceId'>) => Promise<ActorIdentity | null>;
  agent: (id: string, actor?: ActorIdentity, conversationId?: string) => Promise<AgentDefinition | null>;
  workspace: (id: string) => Promise<WorkspaceDefinition | null>;
  /** 共享频道等额外读取授权由可信宿主按当前账号检查，公开请求不能自行授予。 */
  canAccessConversation?: (actor: ActorIdentity, conversation: PlatformConversation) => Promise<boolean>;
  questionTimeoutMs?: number;
  preparePrompt?: (input: { request: StartRunInput | ContinueRunInput; agent: AgentDefinition; actor: ActorIdentity; workspace?: WorkspaceDefinition;
    history: PlatformMessage[]; conversation: PlatformConversation; previousTurn?: PlatformMessage; clientId?: string; automationId?: string; signal?: AbortSignal }) => Promise<{
    systemPrompt: string; toolNames: string[]; messageMetadata?: Record<string, unknown>; messageParts?: PlatformMessage['parts']; turnContext?: Record<string, unknown>; promptContext?: ModelInput['promptContext'];
  }>;
  transformOutput?: (input: { run: RunRecord; message: PlatformMessage; request: ModelInput }) => Promise<PlatformMessage>;
  prepareModel?: (context: ModelRequestContext) => Promise<{ history: ConversationState; messages: PlatformMessage[] }>;
  /** 只读投影，不能调用模型、写入历史或执行运行前的任务副作用。 */
  previewModel?: (context: ModelRequestContext) => Promise<{ history: ConversationState; messages: PlatformMessage[]; notices?: string[] }>;
  /** 可选宿主生命周期端口；授权检查仍由运行器负责。 */
  beforeRun?: (run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal) => Promise<void>;
  modelBoundary?: (run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal, phase: 'before' | 'after', iteration: number, message?: PlatformMessage) => Promise<void>;
  beforeTool?: (context: ToolContext, name: string, args: Record<string, unknown>, effects: ToolEffect[]) => Promise<void>;
  afterTools?: (run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal, message: PlatformMessage) => Promise<void | { stop: boolean; reason?: string }>;
  /** 自动任务的调用归属由宿主异步作用域提供，包含内部总结与子任务。 */
  currentAutomationId?: () => string | undefined;
  runInScope?: (run: RunRecord, execute: () => Promise<void>) => Promise<void>;
  /** 在模型边界接收已持久化的后台任务结果，返回是否追加了新消息。 */
  deliverFeedback?: (run: RunRecord) => Promise<boolean>;
  /** 已脱离原生成任务的异步结果复用宿主的持久反馈队列。 */
  deliverAsyncToolResult?: (run: RunRecord, message: PlatformMessage) => Promise<void>;
  /** 重启仅恢复已保存的终态，不能重新执行原操作。 */
  recoverAsyncToolResult?: (record: NativeToolRecord) => Promise<ToolOutcome | undefined>;
  review?: (input: { agent: AgentDefinition; toolName: string; args: Record<string, unknown>; effects: ToolEffect[]; signal: AbortSignal }) => Promise<{ requireApproval: boolean; reason?: string }>;
}
export interface ModelRequestContext {
  run: RunRecord;
  agent: AgentDefinition;
  workspace?: WorkspaceDefinition;
  iteration: number;
  input: ModelInput;
  /** 原始只读快照；上下文修改应通过独立副本和会话事务发布。 */
  history: ConversationState;
}
export type RuntimeNotification = { type: 'event'; event: RunEvent }
  | { type: 'runtime.preparation.changed' }
  | { type: 'run.created'; runId: string; run: RunRecord; message?: PlatformMessage }
  | { type: 'message.persisted'; runId: string; content: PlatformMessage }
  | { type: 'model.continued'; runId: string }
  | { type: 'model.delta'; runId: string; parts: Record<string, unknown>[] }
  | { type: 'model.retrying'; runId: string; attempt: number; maxAttempts: number; error: string; nextRetryIn: number }
  | { type: 'tool.progress'; runId: string; toolCallId: string; payload: Record<string, unknown> };
interface ActiveRun { conversationId: string; actorId: string; controller: AbortController; done: Promise<void> }
interface PendingApproval { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }
interface FunctionCall extends ModelToolCall {}
export interface PreparedConversationChange {
  /** 仅由可信宿主提供的来源记录；公开请求不能直接提交此对象。 */
  messageMetadata?: Record<string, unknown>;
  state: ConversationState;
  commit: Pick<ConversationCommit, 'messages' | 'metadata' | 'records' | 'snapshot'>;
}

/** 可信宿主捕获的任务上下文；公开请求参数不能提供或覆盖此对象。 */
export interface RuntimeRunScope {
  nodeOrigin?: RunRecord['nodeOrigin'];
  automationId?: string;
  workspace?: WorkspaceDefinition;
  clientId?: string;
  /** 可信调用方取消已受理的启动请求；连接断开不触发此信号。 */
  signal?: AbortSignal;
  modelSelection?: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>;
  modelRetryCount?: number;
}

function captureRunScope(scope?: RuntimeRunScope): RuntimeRunScope | undefined {
  if (!scope) return undefined;
  // AbortSignal 不能结构化克隆；其他上下文仍在受理时捕获独立快照。
  const { signal, ...snapshot } = scope;
  return { ...structuredClone(snapshot), ...(signal ? { signal } : {}) };
}

/** The task owns generation and tool execution; client disconnects never own its lifetime. */
export class PlatformRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly starting = new Set<Promise<RunRecord>>();
  get activeCount(): number { return this.active.size; }
  get preparingCount(): number { return this.starting.size; }
  activeRunIds(conversationId: string): string[] {
    return [...this.active].filter(([, value]) => value.conversationId === conversationId).map(([id]) => id);
  }
  /** 本进程正在执行的任务所属账号；已结束或不属于本进程时返回 undefined。 */
  activeActorId(runId: string): string | undefined { return this.active.get(runId)?.actorId; }
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: RuntimeNotification) => void>();
  private closing = false;
  private readonly questions: QuestionBroker;
  private readonly nativeTools: NativeAsyncTools;
  constructor(private readonly services: RuntimeServices) {
    this.nativeTools = new NativeAsyncTools(services.storage, (record, detached) => this.deliverNativeResult(record, detached),
      id => {
        const active = this.active.get(id);
        return !active ? 'finished' : active.controller.signal.aborted ? 'settling' : 'active';
      });
    this.questions = new QuestionBroker(services.questionTimeoutMs ?? 180_000, feedback => {
      void this.event(feedback.request.runId, feedback.timedOut ? 'question.expired' : 'question.answered', {
        requestId: feedback.request.id, answers: feedback.answers, answeredBy: feedback.answeredBy,
      }).catch(() => undefined);
    });
  }

  subscribe(listener: (event: RuntimeNotification) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private notify(event: RuntimeNotification): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* A broken subscriber cannot abort a task. */ } }
  }
  private async event(runId: string, type: RunEvent['type'], payload: Record<string, unknown>, update?: { status?: RunRecord['status']; iteration?: number; error?: string }): Promise<void> {
    const event = await this.services.storage.appendRunEvent({ runId, type, payload, update });
    this.notify({ type: 'event', event });
  }

  async initialize(): Promise<void> {
    // 同一会话的待结算调用共用导航摘要；恢复只判断配对身份，不反复读取正文和附件。
    const recoveredHistories = new Map<string, { calls: Set<string>; responses: Set<string> } | null>();
    for (const id of await this.services.storage.listRecords(NATIVE_ASYNC_NAMESPACE)) {
      const record = await this.services.storage.getRecord(NATIVE_ASYNC_NAMESPACE, id) as NativeToolRecord | null;
      if (!record) continue;
      let history = recoveredHistories.get(record.run.conversationId);
      if (history === undefined) {
        history = null;
        if (await this.services.storage.getConversation(record.run.conversationId)) {
          const outline = await this.services.storage.readHistoryOutline(record.run.conversationId);
          history = { calls: new Set(), responses: new Set() };
          for (const entry of outline.entries) {
            for (const call of entry.calls ?? []) history.calls.add(call.id);
            for (const response of entry.responses ?? []) history.responses.add(response.id);
          }
        }
        recoveredHistories.set(record.run.conversationId, history);
      }
      if (!history) {
        await this.services.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, id); continue;
      }
      const hasCall = history.calls.has(record.call.id);
      if (!hasCall && record.published) { await this.services.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, id); continue; }
      if (!hasCall) {
        const page = await this.services.storage.readHistory(record.run.conversationId, { limit: 1 });
        await this.services.storage.appendHistory(record.run.conversationId, [{ id: randomUUID(), role: 'model', runId: record.run.id,
          timestamp: Date.now(), parentId: page.messages.at(-1)?.id ?? null, incompleteReason: 'interrupted', parts: [{ functionCall: record.call }] }]);
        history.calls.add(record.call.id);
      }
      if (!history.responses.has(record.call.id)) {
        const outcome = record.outcome ?? await this.services.recoverAsyncToolResult?.(record)
          ?? { success: false, code: 'INTERRUPTED', error: '服务重启，原异步操作未自动重放。' };
        await this.saveToolResult(record.run, record.call, outcome);
        history.responses.add(record.call.id);
      }
      await this.services.storage.deleteRecord(NATIVE_ASYNC_NAMESPACE, id);
    }
    // Previously executing operations are settled as interrupted, never replayed on service startup.
    for (;;) {
      const runs = await this.services.storage.listRuns({ activeOnly: true });
      if (!runs.length) break;
      for (const run of runs) {
        await this.settleInterrupted(run);
        await this.event(run.id, 'run.interrupted', { reason: 'Service restarted before completion.' }, { status: 'interrupted' });
      }
    }
  }

  /** 仅供持有后台任务的宿主交付终态，公开 RPC 不暴露这个入口。 */
  completeAsyncTool(runId: string, callId: string, outcome: ToolOutcome): Promise<boolean> {
    return this.nativeTools.complete(runId, callId, outcome);
  }
  pendingAsyncToolCalls(conversationId: string): string[] { return this.nativeTools.pendingIds(conversationId); }

  /** 第三个参数仅由可信宿主传入，不从公共任务请求或模型参数读取。 */
  start(input: StartRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    return this.begin(structuredClone(input), change, captureRunScope(scope));
  }
  continue(input: ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    return this.begin(structuredClone(input), change, captureRunScope(scope));
  }
  private async prepareRun(input: StartRunInput | ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope) {
    if (this.closing) throw new Error('Runtime is closing.');
    scope?.signal?.throwIfAborted();
    const actor = await this.services.actor(input.actorId, { conversationId: input.conversationId, workspaceId: input.workspaceId });
    const agent = await this.services.agent(input.agentId, actor ?? undefined, input.conversationId);
    if (!actor || actor.revoked || !agent) throw new Error('Actor or agent is unavailable.');
    if (actor.role !== 'owner' && (input.providerId || input.modelOverride || input.reasoningEffort || input.promptModeId)) throw new Error('Only the owner may override the configured provider or preset for a run.');
    if (!Number.isSafeInteger(agent.maxIterations) || (agent.maxIterations < 1 && agent.maxIterations !== -1)) throw new Error('Configure a positive iteration limit, or -1 for unlimited.');
    if (!['sensitive', 'all_mutations'].includes(agent.approvalMode)) throw new Error('Configure the tool approval mode.');
    const hasWorkspaceSnapshot = scope && Object.hasOwn(scope, 'workspace');
    const workspace = hasWorkspaceSnapshot ? scope?.workspace : input.workspaceId ? await this.services.workspace(input.workspaceId) : undefined;
    if (hasWorkspaceSnapshot && input.workspaceId !== workspace?.id) throw new Error('保存的任务工作区与请求不一致。');
    if (input.workspaceId && !workspace) throw new Error('Workspace not found.');
    const denied = authorizeEffects(actor, [], workspace ?? undefined);
    if (denied) throw new Error(denied);
    const state = change?.state ?? await this.services.storage.readConversationState(input.conversationId);
    const conversation = state.metadata;
    if (conversation.id !== input.conversationId) throw new Error('History change belongs to another conversation.');
    if (!conversation || (actor.role !== 'owner' && conversation.actorId !== actor.id
      && !await this.services.canAccessConversation?.(actor, conversation))) throw new Error('Conversation is not accessible to this account.');
    const source = 'message' in input ? input.message : undefined;
    if (source && !source.id) source.id = randomUUID();
    if (source && (!Array.isArray(source.parts) || source.parts.some(part => !part || typeof part !== 'object' || part.functionCall || part.functionResponse))) throw new Error('Input must contain user content, not tool protocol messages.');
    const history = change?.commit.messages ?? state.history.messages;
    if (!source && (!history.length || !('expectedRevision' in input) || input.expectedRevision !== state.history.revision))
      throw new Error('Continuation requires nonempty history at the requested revision.');
    const previousTurn = source ? undefined : [...history].reverse().find(message => message.isUserInput && !message.userFeedback);
    if (!source && actor.role !== 'owner' && conversation.actorId !== actor.id && previousTurn?.actorId !== actor.id)
      throw new Error('不能继续其他成员发起的回合，请发送自己的新消息。');
    const modelSelection = scope?.modelSelection ?? { providerId: input.providerId ?? agent.providerId, modelOverride: input.modelOverride ?? agent.modelId, reasoningEffort: input.reasoningEffort };
    const configuredRequest = { ...input, ...modelSelection };
    const automationId = scope?.automationId ?? this.services.currentAutomationId?.();
    scope?.signal?.throwIfAborted();
    const prepared = await this.services.preparePrompt?.({ request: configuredRequest, agent: structuredClone(agent), actor, workspace: workspace ?? undefined,
      history, conversation: change?.commit.metadata ?? conversation, previousTurn, clientId: scope?.clientId, automationId, signal: scope?.signal });
    scope?.signal?.throwIfAborted();
    const names = prepared?.toolNames ?? agent.toolNames;
    const catalog = this.services.prepareTools ? await this.services.prepareTools(names, configuredRequest, agent) : this.services.tools.catalog(names);
    scope?.signal?.throwIfAborted();
    const now = Date.now();
    const run: RunRecord = { id: randomUUID(), requestKey: input.requestKey, conversationId: input.conversationId,
      executionNodeId: this.services.executionNodeId?.(), nodeOrigin: scope?.nodeOrigin ?? this.services.currentNodeOrigin?.(),
      actorId: actor.id, agentId: agent.id, workspaceId: workspace?.id, status: 'queued', createdAt: now,
      updatedAt: now, iteration: 0, catalogVersion: catalog.version, ...(automationId ? { automationId } : {}),
      ...(!source && typeof history.at(-1)?.runId === 'string' ? { continuationOf: history.at(-1)!.runId as string } : {}) };
    const message: PlatformMessage | undefined = source ? { ...change?.messageMetadata, ...prepared?.messageMetadata,
      ...(typeof source.deepSeekVisionTileSplit === 'boolean' ? { deepSeekVisionTileSplit: source.deepSeekVisionTileSplit } : {}),
      role: 'user', parts: structuredClone(prepared?.messageParts ?? source.parts), id: source.id || randomUUID(),
      timestamp: now, parentId: history.at(-1)?.id ?? null, actorId: actor.id, isUserInput: true, runId: run.id, requestKey: run.requestKey } : undefined;
    const selection = { ...modelSelection, retryCount: scope?.modelRetryCount, promptContext: prepared?.promptContext, turnContext: prepared?.turnContext };
    const configuredAgent = { ...agent, systemPrompt: prepared?.systemPrompt ?? agent.systemPrompt };
    return { actor, workspace, state, catalog, modelSelection, prepared, run, message, selection, configuredAgent };
  }
  /** 预览与发送共用回合捕获和权限检查，但不创建任务与历史记录。 */
  async preview(input: StartRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope) {
    const turn = await this.prepareRun(structuredClone(input), change, captureRunScope(scope));
    const { actor, workspace, catalog, run, message, selection, configuredAgent } = turn;
    const state = structuredClone(turn.state);
    state.metadata = structuredClone(change?.commit.metadata ?? state.metadata);
    state.history.messages = structuredClone(change?.commit.messages ?? state.history.messages);
    if (message) state.history.messages.push(message);
    state.history.total = state.history.messages.length;
    const request = this.modelInput(run, configuredAgent, workspace ?? undefined, actor, catalog, state.history.messages, selection, new AbortController().signal);
    if (this.services.prepareModel && !this.services.previewModel) throw new Error('当前宿主尚未提供只读提示词预览。');
    const prepared = await this.services.previewModel?.({ run, agent: configuredAgent, workspace: workspace ?? undefined, iteration: 1, input: request, history: state });
    if (prepared) request.messages = prepared.messages;
    return { input: request, notices: prepared?.notices ?? [] };
  }
  private begin(input: StartRunInput | ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    const pending = this.beginRun(input, change, scope);
    this.starting.add(pending);
    void pending.finally(() => {
      this.starting.delete(pending);
      // 正式运行 RPC 的准备失败也没有持久化事件，宿主仍需重新检查退出条件。
      this.notify({ type: 'runtime.preparation.changed' });
    }).catch(() => undefined);
    return pending;
  }
  private async beginRun(input: StartRunInput | ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    const { workspace, state, catalog, modelSelection, prepared, run, message, selection, configuredAgent } = await this.prepareRun(input, change, scope);
    if (this.closing) throw new Error('Runtime is closing.');
    scope?.signal?.throwIfAborted();
    const committed = await this.services.storage.commitConversation({ conversationId: input.conversationId,
      expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, ...change?.commit,
      records: [...(change?.commit.records ?? []), { namespace: 'run-configurations', id: run.id, ownerId: run.conversationId,
        value: { ...modelSelection, ...(run.automationId ? { automationId: run.automationId } : {}), ...(run.nodeOrigin ? { nodeOrigin: run.nodeOrigin } : {}),
          promptModeId: input.promptModeId ?? prepared?.messageMetadata?.promptModeId, workspace: workspace ?? null } }],
      startRun: { run, message } });
    const result = committed.run!;
    if (!result.created) return result.run;
    const controller = new AbortController();
    // 提交已经开始时仍需结算任务，但关闭后不能启动模型或工具。
    if (this.closing) controller.abort(new Error('Runtime is shutting down.'));
    const abort = () => controller.abort(scope?.signal?.reason);
    if (scope?.signal?.aborted) abort();
    else scope?.signal?.addEventListener('abort', abort, { once: true });
    // Defer work one microtask so cancellation sees the run even when it arrives immediately.
    const execute = () => this.execute(run, structuredClone(configuredAgent), workspace ? structuredClone(workspace) : undefined, catalog, controller.signal, selection);
    const done = Promise.resolve().then(() => this.services.runInScope ? this.services.runInScope(run, execute) : execute())
      .finally(() => { scope?.signal?.removeEventListener('abort', abort); this.active.delete(run.id); this.questions.clear(run.id); });
    this.active.set(run.id, { conversationId: run.conversationId, actorId: run.actorId, controller, done });
    // 对话事务和取消句柄都已建立，界面才开始订阅这一轮任务。
    this.notify({ type: 'run.created', runId: run.id, run: structuredClone(run), ...(message ? { message: structuredClone(message) } : {}) });
    void done.catch(() => undefined);
    return run;
  }

  private modelInput(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, actor: ActorIdentity, catalog: ToolCatalog,
    messages: PlatformMessage[], selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort' | 'promptContext' | 'turnContext' | 'retryCount'>, signal: AbortSignal): ModelInput {
    return { conversationId: run.conversationId, ...selection, systemPrompt: agent.systemPrompt, messages,
      taskContext: { actor: { id: actor.id, displayName: actor.displayName, role: actor.role }, workspace },
      tools: structuredClone(catalog.declarations), signal };
  }

  async wait(runId: string): Promise<RunRecord | null> {
    await this.active.get(runId)?.done;
    return this.services.storage.getRun(runId);
  }
  async cancel(runId: string, actorId: string): Promise<void> {
    // 活跃任务的归属已在内存中，授权后立即中止；存储线程繁忙时停止不必排在大请求之后。
    const active = this.active.get(runId);
    const ownerId = active?.actorId ?? (await this.services.storage.getRun(runId))?.actorId;
    const actor = await this.services.actor(actorId);
    if (ownerId === undefined || !actor || actor.revoked || (actor.role !== 'owner' && actor.id !== ownerId)) throw new Error('This account cannot cancel the run.');
    (active ?? this.active.get(runId))?.controller.abort(new Error('Cancelled by user.'));
  }
  /** 宿主生命周期端口，不作为远程 RPC 暴露；用于结束已确认归属的子任务。 */
  interrupt(runId: string, reason: Error): void { this.active.get(runId)?.controller.abort(reason); }
  async resolveApproval(approvalId: string, actorId: string, accepted: boolean, choiceId?: string): Promise<void> {
    const actor = await this.services.actor(actorId);
    if (!actor || actor.revoked || (actor.role !== 'owner' && !actor.effects.includes('administration'))) throw new Error('This account cannot approve operations.');
    if (typeof accepted !== 'boolean') throw new Error('Explicit approval or rejection is required.');
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Approval has expired or was already resolved.');
    if (pending.request.choices) {
      const choice = pending.request.choices.find(item => item.id === choiceId);
      if (!choice) throw new Error('请选择这个请求提供的具体选项。');
      accepted = choice.kind === 'allow_once' || choice.kind === 'allow_always';
    } else if (choiceId !== undefined) throw new Error('这个请求没有可选项。');
    this.approvals.delete(approvalId); pending.resolve({ accepted, ...(choiceId !== undefined ? { choiceId } : {}) });
  }
  pendingApprovals(): ApprovalRequest[] { return [...this.approvals.values()].map(value => structuredClone(value.request)); }
  pendingQuestions() { return this.questions.list(); }
  async answerQuestion(questionId: string, actorId: string, answers: string[]): Promise<void> {
    const actor = await this.services.actor(actorId);
    const question = this.questions.list().find(value => value.id === questionId);
    if (!actor || actor.revoked || !question || (actor.role !== 'owner' && question.actorId !== actor.id)) throw new Error('This account cannot answer the question.');
    this.questions.answer(questionId, answers, actorId);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const run of this.active.values()) run.controller.abort(new Error('Runtime is shutting down.'));
    // 启动准备和存储提交都先于 active 注册；关闭存储前必须等它们完成或拒绝。
    await Promise.allSettled([...this.starting]);
    await Promise.allSettled([...this.active.values()].map(run => run.done));
  }

  private async execute(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, catalog: ToolCatalog, signal: AbortSignal, selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort' | 'promptContext' | 'turnContext' | 'retryCount'>): Promise<void> {
    const executionController = new AbortController();
    let interrupted = false;
    try {
      signal.throwIfAborted();
      await this.event(run.id, 'run.started', {}, { status: 'running' });
      await this.services.beforeRun?.(run, workspace, signal);
      let historyMessages: PlatformMessage[] = [];
      let historyRevision: number | undefined;
      for (let iteration = 1; agent.maxIterations === -1 || iteration <= agent.maxIterations; iteration++) {
        signal.throwIfAborted();
        if (this.nativeTools.pendingIds(run.conversationId).length)
          await this.nativeTools.reconcile(run.conversationId, (await this.services.storage.readFullHistory(run.conversationId)).messages);
        await this.nativeTools.flush(run.conversationId);
        await this.services.deliverFeedback?.(run);
        await this.drainFeedback(run);
        const actor = await this.services.actor(run.actorId, run);
        if (!actor || actor.revoked) throw new Error('Run account was revoked.');
        const access = authorizeEffects(actor, [], workspace);
        if (access) throw new Error(access);
        let state = await this.services.storage.readConversationState(run.conversationId, undefined, { runId: run.id, revision: historyRevision });
        const incoming = state.history;
        historyMessages = [...historyMessages.slice(0, incoming.startIndex), ...incoming.messages];
        historyRevision = incoming.revision;
        state = { ...state, history: { ...incoming, startIndex: 0, messages: historyMessages } };
        run.iteration = iteration;
        await this.event(run.id, 'model.preparing', { iteration }, { iteration });
        let streamingEvent: Promise<void> | undefined;
        // 请求快照与上游请求并行写入；开始流式事件排在请求记录之后，保持事件顺序。
        let requestRecorded: Promise<void> = Promise.resolve();
        const partialParts: PlatformMessage['parts'] = [];
        const deltas = new DeltaCoalescer(parts => {
          // 已显示的正文和思考均保留；未完成签名、工具参数不能成为可执行的历史调用。
          for (const part of parts) if (typeof part.text === 'string') {
            const thought = part.thought === true;
            const previous = partialParts.at(-1);
            if (previous && !!previous.thought === thought) previous.text = String(previous.text ?? '') + part.text;
            else partialParts.push({ text: part.text, ...(thought ? { thought: true } : {}) });
          }
          this.notify({ type: 'model.delta', runId: run.id, parts });
        });
        const early = new Map<string, { call: FunctionCall }>();
        const earlyController = new AbortController();
        const earlySignal = AbortSignal.any([signal, executionController.signal, earlyController.signal]);
        const request: ModelInput = { ...this.modelInput(run, agent, workspace, actor, catalog, state.history.messages, selection, signal),
          runId: run.id,
          pendingToolCallIds: this.nativeTools.pendingIds(run.conversationId),
          onToolCallReady: call => {
            if (early.has(call.id) || earlySignal.aborted || call.async !== true || !request.tools.some(tool => tool.name === call.name && tool.async)
              || !this.nativeCall(call, agent, catalog)) return false;
            const saved = structuredClone(call);
            // 排队调用可能跨过后续模型迭代，工具的审批与副作用记录仍归属发出它的原始轮次。
            const toolRun = structuredClone(run);
            const accepted = this.nativeTools.launch(run, saved, state.history.messages, async () => earlySignal.aborted
              ? { success: false, code: 'CANCELLED', error: 'Task was cancelled before execution.' }
              : this.executeTool(toolRun, agent, workspace, catalog, saved, earlySignal, request, true));
            if (accepted) early.set(call.id, { call: saved });
            return accepted;
          },
          onRequest: captured => requestRecorded = (async () => {
            const id = `${run.id}:${iteration}`;
            await this.services.storage.putRecord({ namespace: 'model-requests', id, ownerId: run.conversationId,
              value: { ...captured, runId: run.id, iteration, capturedAt: Date.now(), turnContext: request.turnContext,
                // 手动总结复用最近真实调用的固定前缀；不保存信号、回调和认证头。
                prefix: { conversationId: request.conversationId, providerId: request.providerId, modelOverride: captured.model,
                  reasoningEffort: request.reasoningEffort, systemPrompt: request.systemPrompt, tools: request.tools,
                  promptContext: request.promptContext, taskContext: request.taskContext, turnContext: request.turnContext } } satisfies ModelRequestSnapshot });
            await this.event(run.id, 'model.request', { iteration, requestId: id, protocol: captured.protocol, model: captured.model,
              ...(captured.metrics ? { metrics: captured.metrics } : {}) });
          })(),
          onRetry: status => {
            // 上一次尝试只推送了思考；丢弃后界面与中断时保存的部分回复都从下一次尝试重新开始。
            deltas.discard(); partialParts.length = 0;
            this.notify({ type: 'model.retrying', runId: run.id, ...status });
          },
          onDelta: parts => {
            if (deltas.closed || signal.aborted) return;
            if (!streamingEvent) {
              streamingEvent = requestRecorded.catch(() => undefined).then(() => this.event(run.id, 'model.streaming', { iteration }));
              void streamingEvent.catch(() => undefined);
            }
            deltas.push(parts);
          },
        };
        const nativeEnabled = await this.services.models.supportsAsyncTools?.(request) ?? false;
        request.tools = request.tools.map(tool => {
          const runtimeTool = catalog.entries.get(tool.name)?.tool;
          const allowed = runtimeTool?.nativeAsync !== false && agent.toolApproval?.[tool.name] !== 'deny' && (runtimeTool?.nativeAsync === true
            || runtimeTool?.parallelRead === true && agent.toolApproval?.[tool.name] !== 'ask'
              && !(agent.reviewerProviderId && agent.reviewerToolNames?.includes(tool.name)));
          if (nativeEnabled && allowed) return nativeToolDeclaration(tool, runtimeTool?.nativeAsyncDescription, runtimeTool?.nativeAsyncParameterDescriptions);
          // 存储会省略 undefined；同步声明直接移除标记，让保存前后的完整前缀保持同一结构。
          const { async: _async, ...synchronous } = tool;
          return synchronous;
        });
        if (request.tools.some(tool => tool.async)) request.tools.push(structuredClone(waitForTasksDeclaration));
        const prepared = await this.services.prepareModel?.({ run, agent, workspace, iteration, input: request, history: state });
        if (prepared) { state = prepared.history; request.messages = prepared.messages; }
        const page = state.history;
        signal.throwIfAborted();
        await this.services.modelBoundary?.(run, workspace, signal, 'before', iteration);
        signal.throwIfAborted();
        await this.event(run.id, 'model.started', { iteration });
        let generated: PlatformMessage;
        try {
          try {
            generated = await this.services.models.generate(request);
            for (const { call } of early.values()) {
              const returned = generated.parts.find(part => (part.functionCall as FunctionCall | undefined)?.id === call.id)?.functionCall as FunctionCall | undefined;
              if (!returned || returned.name !== call.name || returned.namespace !== call.namespace || JSON.stringify(returned.args) !== JSON.stringify(call.args)) throw new Error('原生异步调用的终态与已发出的完整参数不一致。');
              // 已接管的调用不能因流末标记变化再次执行，历史与等待继续使用原执行身份。
              returned.async = true;
            }
          }
          finally { deltas.finish(); await streamingEvent; }
          signal.throwIfAborted();
        } catch (error) {
          earlyController.abort(error);
          // 完整发出的只读调用已经执行或取消，必须保留配对身份，后续不再重复执行。
          for (const { call } of early.values()) partialParts.push({ functionCall: call });
          if (partialParts.some(part => part.functionCall || typeof part.text === 'string' && part.text.trim())) {
            let partial: PlatformMessage = { role: 'model', id: randomUUID(), runId: run.id, requestKey: run.requestKey,
              parentId: page.messages.at(-1)?.id ?? null, timestamp: Date.now(), parts: partialParts, modelVersion: request.modelOverride,
              incompleteReason: signal.aborted ? 'cancelled' : 'interrupted', usageMetadataPartial: true };
            // 沿用来源标注钩子，使记忆遗忘与角色会话仍能追溯这段输出的依据。
            if (this.services.transformOutput) partial = await this.services.transformOutput({ run, message: partial, request });
            await this.services.storage.appendHistory(run.conversationId, [partial], { expectedRevision: page.revision });
            await this.nativeTools.publish(run.id, [...early.values()].map(value => value.call));
            this.notify({ type: 'message.persisted', runId: run.id, content: structuredClone(partial) });
            await this.event(run.id, 'message.saved', { messageId: partial.id, incompleteReason: partial.incompleteReason, streaming: deltas.statistics() }, { iteration });
          }
          throw error;
        }
        partialParts.length = 0;
        let content: PlatformMessage = { ...generated, role: 'model', id: randomUUID(), runId: run.id, requestKey: run.requestKey,
          parentId: page.messages.at(-1)?.id ?? null, timestamp: Date.now() };
        if (this.services.transformOutput) content = await this.services.transformOutput({ run, message: content, request });
        const calls = this.calls(content);
        await this.services.storage.appendHistory(run.conversationId, [content], { expectedRevision: page.revision });
        await this.nativeTools.publish(run.id, calls);
        this.notify({ type: 'message.persisted', runId: run.id, content: structuredClone(content) });
        await this.event(run.id, 'message.saved', { messageId: content.id, streaming: deltas.statistics() }, { iteration });
        await this.services.modelBoundary?.(run, workspace, signal, 'after', iteration, content);
        const deliveredNative = await this.nativeTools.flush(run.conversationId);
        if (!calls.length) {
          if (deliveredNative) continue;
          if (this.nativeTools.pendingIds(run.conversationId).length) {
            await this.nativeTools.waitAny(run.conversationId, signal); continue;
          }
          if (this.services.models.hasContinuation?.(run.id)) { this.notify({ type: 'model.continued', runId: run.id }); continue; }
          if (await this.services.deliverFeedback?.(run)) { this.notify({ type: 'model.continued', runId: run.id }); continue; }
          if (this.questions.hasFeedback(run.id)) { this.notify({ type: 'model.continued', runId: run.id }); await this.drainFeedback(run); continue; }
          if (this.questions.list(run.id).length) {
            this.notify({ type: 'model.continued', runId: run.id });
            await this.event(run.id, 'run.waiting_input', {}, { status: 'awaiting_input' });
            await this.questions.wait(run.id, signal);
            await this.event(run.id, 'run.started', { resumedAfterQuestion: true }, { status: 'running' });
            await this.drainFeedback(run); continue;
          }
          signal.throwIfAborted();
          await this.event(run.id, 'run.completed', {}, { status: 'completed' }); return;
        }
        for (let index = 0; index < calls.length;) {
          const next = calls[index];
          if (next.name === WAIT_FOR_TASKS && request.tools.some(tool => tool.name === WAIT_FOR_TASKS)) {
            index++;
            const outcome = Object.keys(next.args).some(key => key !== 'task_handles')
              ? { success: false, code: 'INVALID_ARGUMENTS', error: 'wait_for_tasks 只接受 task_handles。' }
              : await this.nativeTools.wait(run.conversationId, next.args.task_handles, signal);
            await this.saveToolResult(run, next, outcome); continue;
          }
          if (nativeEnabled && next.async && request.tools.some(tool => tool.name === next.name && tool.async) && this.nativeCall(next, agent, catalog)) {
            index++;
            if (!this.nativeTools.has(run.id, next.id)) {
              const toolRun = structuredClone(run);
              this.nativeTools.launch(run, next, page.messages,
                () => this.executeTool(toolRun, agent, workspace, catalog, next, earlySignal, request, true));
            }
            await this.nativeTools.publish(run.id, [next]); continue;
          }
          const batch = [calls[index++]];
          if (this.parallelRead(batch[0], agent, catalog)) {
            while (batch.length < 4 && index < calls.length && !calls[index].async && this.parallelRead(calls[index], agent, catalog)) batch.push(calls[index++]);
          }
          const outcomes = await Promise.all(batch.map(call => signal.aborted
            ? { success: false, code: 'CANCELLED', error: 'Task was cancelled before execution.' }
            : this.executeTool(run, agent, workspace, catalog, call, signal, request)));
          // 完成时间可以不同，持久化和后续模型输入始终服从原始调用顺序。
          for (let item = 0; item < batch.length; item++) await this.saveToolResult(run, batch[item], outcomes[item]);
        }
        await this.nativeTools.flush(run.conversationId);
        const afterTools = await this.services.afterTools?.(run, workspace, signal, content);
        if (afterTools?.stop) {
          await this.event(run.id, 'run.completed', { reason: afterTools.reason ?? 'document_confirmation' }, { status: 'completed' }); return;
        }
      }
      throw new Error(`The configured iteration limit (${agent.maxIterations}) was reached.`);
    } catch (error) {
      executionController.abort(error);
      const detached = await this.nativeTools.interrupt(run.id);
      await this.settleInterrupted(run, signal.aborted ? 'CANCELLED' : 'INTERRUPTED', detached);
      interrupted = true;
      const retry = (error as { modelRetry?: { kind?: string; remainingRetries?: number; resumeSafe?: boolean; delayMs?: number } })?.modelRetry;
      const modelRetry = retry?.kind === 'rate_limit' && Number.isSafeInteger(retry.remainingRetries) && Number.isFinite(retry.delayMs)
        ? { kind: 'rate_limit', remainingRetries: retry.remainingRetries, resumeSafe: retry.resumeSafe === true, delayMs: Math.max(0, retry.delayMs!) } : undefined;
      await this.event(run.id, signal.aborted ? 'run.cancelled' : 'run.failed', { error: error instanceof Error ? error.message : String(error), ...(modelRetry ? { modelRetry } : {}) }, {
        status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      executionController.abort();
      if (!interrupted && this.nativeTools.pendingIds(run.conversationId).length) {
        const detached = await this.nativeTools.interrupt(run.id);
        await this.settleInterrupted(run, 'CANCELLED', detached);
      }
      await this.nativeTools.release(run.id);
      this.services.models.endRun?.(run.id);
    }
  }

  private calls(message: PlatformMessage): FunctionCall[] {
    if (!Array.isArray(message.parts)) throw new Error('Model response has no parts array.');
    const calls: FunctionCall[] = [];
    const ids = new Set<string>();
    for (const part of message.parts) {
      if (!part.functionCall) continue;
      const source = part.functionCall as Partial<FunctionCall>;
      const id = source.id ?? randomUUID();
      if (typeof id !== 'string' || ids.has(id) || typeof source.name !== 'string') throw new Error('Model returned invalid or duplicate tool identities.');
      ids.add(id);
      const call = { id, name: source.name, args: source.args ?? {}, ...(source.async === true ? { async: true } : {}),
        ...(typeof source.namespace === 'string' ? { namespace: source.namespace } : {}) };
      part.functionCall = { ...source, id };
      calls.push(call);
    }
    return calls;
  }

  private nativeCall(call: FunctionCall, agent: AgentDefinition, catalog: ToolCatalog): boolean {
    if (catalog.entries.get(call.name)?.tool.nativeAsync === false) return false;
    if (catalog.entries.get(call.name)?.tool.nativeAsync === true) return agent.toolApproval?.[call.name] !== 'deny';
    const { task_handle: _handle, ...args } = call.args;
    return this.parallelRead({ ...call, args }, agent, catalog);
  }

  private parallelRead(call: FunctionCall, agent: AgentDefinition, catalog: ToolCatalog): boolean {
    const entry = catalog.entries.get(call.name);
    if (!entry || agent.reviewerProviderId && agent.reviewerToolNames?.includes(call.name)) return false;
    try {
      const args = normalizeToolArguments(call.args, entry.tool.declaration.parameters);
      const preparedArgs = entry.tool.normalizeArgs?.(args).args ?? args;
      const readOnly = typeof entry.tool.parallelRead === 'function' ? entry.tool.parallelRead(preparedArgs) : entry.tool.parallelRead;
      if (!readOnly) return false;
      const effects = entry.tool.effects(preparedArgs);
      return effects.every(effect => effect === 'public_read' || effect === 'workspace_read') && !needsApproval(agent, call.name, effects);
    } catch { return false; }
  }

  private async executeTool(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, catalog: ToolCatalog, call: FunctionCall, signal: AbortSignal, selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>, nativeAsync = false): Promise<ToolOutcome> {
    const nativeTaskHandle = nativeAsync && typeof call.args.task_handle === 'string' ? call.args.task_handle : undefined;
    let parameterWarnings: string[] = [];
    const finish = (result: ToolOutcome): ToolOutcome => parameterWarnings.length
      ? { ...result, parameterWarnings: [...parameterWarnings, ...(Array.isArray(result.parameterWarnings) ? result.parameterWarnings : [])] }
      : result;
    try {
      const entry = catalog.entries.get(call.name);
      if (!entry) return { success: false, code: 'UNKNOWN_TOOL', error: 'Tool is absent from the configured catalog.' };
      const { task_handle: _handle, ...nativeArgs } = call.args;
      call = { ...call, args: normalizeToolArguments(nativeAsync ? nativeArgs : call.args, entry.tool.declaration.parameters) };
      if (entry.tool.normalizeArgs) {
        const prepared = entry.tool.normalizeArgs(call.args);
        call = { ...call, args: prepared.args };
        parameterWarnings = prepared.warnings;
      }
      if (!entry.validate(call.args)) return finish({ success: false, code: 'INVALID_ARGUMENTS', error: `Tool arguments do not match its schema: ${JSON.stringify(entry.validate.errors)}` });
      const effects = entry.tool.effects(call.args);
      const actor = await this.services.actor(run.actorId, run);
      const denied = actor ? authorizeEffects(actor, effects, workspace, call.name) : 'Run account no longer exists.';
      if (denied || agent.toolApproval?.[call.name] === 'deny') return finish({ success: false, code: 'PERMISSION_DENIED', error: denied ?? 'This tool is disabled by its approval rule.' });
      let approval = needsApproval(agent, call.name, effects);
      let reviewReason: string | undefined;
      const reviewed = !approval && !!agent.reviewerProviderId && (agent.reviewerToolNames
        ? agent.reviewerToolNames.includes(call.name) : effects.some(effect => !['public_read', 'workspace_read'].includes(effect)));
      if (reviewed) {
        if (!this.services.review) throw new Error('The configured operation reviewer is unavailable.');
        const review = await this.services.review({ agent, toolName: call.name, args: call.args, effects, signal });
        approval ||= review.requireApproval; reviewReason = review.reason;
      }
      if (approval && !(await this.approve(run, call, effects, signal, reviewReason)).accepted) return finish({ success: false, code: 'PERMISSION_DENIED', error: 'Operation was declined.' });
      // Grants may change while a task waits for approval or a reviewer.
      let current = actor;
      if (reviewed || approval) {
        current = await this.services.actor(run.actorId, run);
        const revoked = current ? authorizeEffects(current, effects, workspace, call.name) : 'Run account no longer exists.';
        if (revoked) return finish({ success: false, code: 'PERMISSION_DENIED', error: revoked });
      }
      signal.throwIfAborted();
      await this.event(run.id, 'tool.started', { toolCallId: call.id, toolName: call.name });
      const context: ToolContext = { runId: run.id, conversationId: run.conversationId, toolCallId: call.id, iteration: run.iteration, actorId: run.actorId, workspace, signal, nativeAsync, nativeTaskHandle,
        approvedByToolConfirmation: approval,
        actor: current ?? undefined,
        requestApproval: async reason => {
          if (approval) return true;
          if (!(await this.approve(run, call, effects, signal, reason)).accepted) return false;
          const latest = await this.services.actor(run.actorId, run);
          const denied = latest ? authorizeEffects(latest, effects, workspace, call.name) : 'Run account no longer exists.';
          if (denied) throw new Error(denied);
          context.actor = latest ?? undefined;
          approval = true;
          context.approvedByToolConfirmation = true;
          return true;
        },
        requestPermission: async (reason, choices, requestSignal) => {
          if (!choices.length || new Set(choices.map(choice => choice.id)).size !== choices.length) throw new Error('权限请求需要提供互不重复的选项。');
          const permissionSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
          const decision = await this.approve(run, call, effects, permissionSignal, reason, choices);
          permissionSignal.throwIfAborted();
          const latest = await this.services.actor(run.actorId, run);
          const denied = latest ? authorizeEffects(latest, effects, workspace, call.name) : 'Run account no longer exists.';
          if (denied) throw new Error(denied);
          context.actor = latest ?? undefined;
          return decision;
        },
        agent: { ...structuredClone(agent), toolNames: catalog.declarations.map(tool => tool.name) },
        modelSelection: { providerId: selection.providerId, modelOverride: selection.modelOverride, reasoningEffort: selection.reasoningEffort },
        askUser: async questions => {
          const request = this.questions.ask(run.id, run.actorId, questions);
          await this.event(run.id, 'question.asked', { ...request });
          return request;
        },
        progress: payload => this.notify({ type: 'tool.progress', runId: run.id, toolCallId: call.id, payload }),
      };
      await this.services.beforeTool?.(context, call.name, call.args, effects);
      // 宿主准备会等待检查点或用户确认，工具执行必须使用这段等待之后的账号授权。
      const latest = await this.services.actor(run.actorId, run);
      signal.throwIfAborted();
      const revoked = latest ? authorizeEffects(latest, effects, workspace, call.name) : 'Run account no longer exists.';
      if (revoked) return finish({ success: false, code: 'PERMISSION_DENIED', error: revoked });
      context.actor = latest ?? undefined;
      return finish(await entry.tool.execute(call.args, context));
    } catch (error) {
      return finish({ success: false, code: signal.aborted ? 'CANCELLED' : 'TOOL_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async approve(run: RunRecord, call: FunctionCall, effects: ToolEffect[], signal: AbortSignal, reason?: string, choices?: ApprovalChoice[]): Promise<ApprovalDecision> {
    signal.throwIfAborted();
    const request: ApprovalRequest = { id: randomUUID(), runId: run.id, actorId: run.actorId,
      toolCallId: call.id, toolName: call.name, args: call.args, effects, workspaceId: run.workspaceId,
      ...(reason ? { reason } : {}), ...(choices ? { choices: structuredClone(choices) } : {}) };
    let settle!: (decision: ApprovalDecision & { cancelled?: true }) => void;
    const accepted = new Promise<ApprovalDecision & { cancelled?: true }>(resolve => { settle = resolve; });
    const abort = () => {
      // 取消不是用户拒绝；同步消耗原请求，不能让迟到/重复确认抢占已取消的审批。
      if (this.approvals.delete(request.id)) settle({ accepted: false, cancelled: true });
    };
    this.approvals.set(request.id, { request, resolve: settle });
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.event(run.id, 'approval.requested', { ...request, ...(reason ? { reason } : {}) }, { status: 'awaiting_approval' });
      const result = await accepted;
      await this.event(run.id, 'approval.resolved', { approvalId: request.id, toolCallId: call.id, toolName: call.name, ...result }, { status: 'running' });
      signal.throwIfAborted();
      return result;
    } finally { signal.removeEventListener('abort', abort); this.approvals.delete(request.id); }
  }

  private async saveToolResult(run: RunRecord, call: Pick<FunctionCall, 'id' | 'name'>, outcome: ToolOutcome): Promise<void> {
    const { attachments, ...response } = outcome;
    const page = await this.services.storage.readHistory(run.conversationId, { limit: 1 });
    const message: PlatformMessage = { id: randomUUID(), role: 'user', runId: run.id, isFunctionResponse: true,
      timestamp: Date.now(), parentId: page.messages.at(-1)?.id ?? null,
      parts: [{ functionResponse: { id: call.id, name: call.name, response } },
        ...(attachments ?? []).map(attachment => ({ inlineData: { mimeType: attachment.mimeType, data: attachment.data },
          ...(attachment.name ? { displayName: attachment.name } : {}) }))] };
    await this.services.storage.appendHistory(run.conversationId, [message], { expectedRevision: page.revision });
    this.notify({ type: 'message.persisted', runId: run.id, content: structuredClone(message) });
    await this.event(run.id, 'tool.completed', { toolCallId: call.id, toolName: call.name, messageId: message.id, success: outcome.success, code: outcome.code });
  }

  private async deliverNativeResult(record: NativeToolRecord, detached: boolean): Promise<void> {
    if (detached && this.services.deliverAsyncToolResult) {
      const history = await this.services.storage.readHistoryOutline(record.run.conversationId);
      if (!history.entries.some(entry => entry.calls?.some(call => call.id === record.call.id))
        || history.entries.some(entry => entry.responses?.some(response => response.id === record.call.id))) return;
      const { attachments, ...response } = record.outcome!;
      const message: PlatformMessage = { id: `native-result-${record.run.id}-${record.call.id}`, role: 'user', runId: record.run.id,
        timestamp: Date.now(), isFunctionResponse: true, isUserInput: false,
        parts: [{ functionResponse: { id: record.call.id, name: record.call.name, response } },
          ...(attachments ?? []).map(item => ({ inlineData: { mimeType: item.mimeType, data: item.data }, ...(item.name ? { displayName: item.name } : {}) }))] };
      await this.services.deliverAsyncToolResult(record.run, message);
    } else await this.saveToolResult(record.run, record.call, record.outcome!);
  }

  private async settleInterrupted(run: RunRecord, code = 'INTERRUPTED', detached: string[] = []): Promise<void> {
    const pending = await this.services.storage.readPendingToolCalls(run.conversationId, run.id);
    for (const call of pending) if (!detached.includes(call.id)) await this.saveToolResult(run, call, { success: false, code, error: 'Execution was interrupted; side effects are not automatically retried.' });
  }

  private async drainFeedback(run: RunRecord): Promise<void> {
    for (const feedback of this.questions.drain(run.id)) {
      const page = await this.services.storage.readHistory(run.conversationId, { limit: 1 });
      const text = feedback.timedOut
        ? `Optional question ${feedback.request.id} received no answer before its deadline. Decide within existing permissions; this is not approval for any restricted operation. Questions: ${JSON.stringify(feedback.request.questions)}`
        : `Answer to optional question ${feedback.request.id}: ${JSON.stringify(feedback.request.questions.map((question, i) => ({ question: question.title, answer: feedback.answers![i] })))}`;
      const message: PlatformMessage = { id: randomUUID(), role: 'user', parts: [{ text }], runId: run.id,
        parentId: page.messages.at(-1)?.id ?? null, timestamp: Date.now(), isUserInput: !feedback.timedOut,
        ...(feedback.answeredBy ? { actorId: feedback.answeredBy } : {}),
        userFeedback: { requestId: feedback.request.id, timedOut: feedback.timedOut,
          questions: feedback.request.questions, answers: feedback.answers ?? [] } };
      await this.services.storage.appendHistory(run.conversationId, [message], { expectedRevision: page.revision });
      this.notify({ type: 'message.persisted', runId: run.id, content: structuredClone(message) });
      await this.event(run.id, 'message.saved', { messageId: message.id, questionId: feedback.request.id });
    }
  }
}
