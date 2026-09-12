import { randomUUID } from 'node:crypto';
import type {
  ActorIdentity, AgentDefinition, ApprovalRequest, ModelProvider, PlatformMessage, RunEvent, RunRecord,
  StartRunInput, ToolEffect, ToolOutcome, WorkspaceDefinition, ModelInput,
  ContinueRunInput, ConversationState, ConversationCommit, PlatformConversation,
} from '@graycode/contracts';
import { PlatformStorage } from '../storage/client';
import { RuntimeToolRegistry, authorizeEffects, needsApproval, type ToolCatalog, type ToolContext } from './tools';
import { QuestionBroker } from './questions';
import { normalizeToolArguments } from './toolArguments';

export interface RuntimeServices {
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
    history: PlatformMessage[]; conversation: PlatformConversation; previousTurn?: PlatformMessage; clientId?: string; automationId?: string }) => Promise<{
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
  review?: (input: { agent: AgentDefinition; toolName: string; args: Record<string, unknown>; effects: ToolEffect[]; signal: AbortSignal }) => Promise<{ requireApproval: boolean; reason?: string }>;
}
export interface ModelRequestContext {
  run: RunRecord;
  agent: AgentDefinition;
  workspace?: WorkspaceDefinition;
  iteration: number;
  input: ModelInput;
  history: ConversationState;
}
export type RuntimeNotification = { type: 'event'; event: RunEvent }
  | { type: 'run.created'; runId: string; run: RunRecord; message?: PlatformMessage }
  | { type: 'message.persisted'; runId: string; content: PlatformMessage }
  | { type: 'model.continued'; runId: string }
  | { type: 'model.delta'; runId: string; parts: Record<string, unknown>[] }
  | { type: 'tool.progress'; runId: string; toolCallId: string; payload: Record<string, unknown> };
interface ActiveRun { controller: AbortController; done: Promise<void> }
interface PendingApproval { request: ApprovalRequest; resolve: (accepted: boolean) => void }
interface FunctionCall { id: string; name: string; args: Record<string, unknown> }
export interface PreparedConversationChange {
  /** 仅由可信宿主提供的来源记录；公开请求不能直接提交此对象。 */
  messageMetadata?: Record<string, unknown>;
  state: ConversationState;
  commit: Pick<ConversationCommit, 'messages' | 'metadata' | 'records' | 'snapshot'>;
}

/** 可信宿主捕获的任务上下文；公开请求参数不能提供或覆盖此对象。 */
export interface RuntimeRunScope {
  automationId?: string;
  workspace?: WorkspaceDefinition;
  clientId?: string;
  modelSelection?: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>;
}

/** The task owns generation and tool execution; client disconnects never own its lifetime. */
export class PlatformRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: RuntimeNotification) => void>();
  private closing = false;
  private readonly questions: QuestionBroker;
  constructor(private readonly services: RuntimeServices) {
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

  /** 第三个参数仅由可信宿主传入，不从公共任务请求或模型参数读取。 */
  start(input: StartRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    return this.begin(structuredClone(input), change, scope ? structuredClone(scope) : undefined);
  }
  continue(input: ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    return this.begin(structuredClone(input), change, scope ? structuredClone(scope) : undefined);
  }
  private async prepareRun(input: StartRunInput | ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope) {
    if (this.closing) throw new Error('Runtime is closing.');
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
    const prepared = await this.services.preparePrompt?.({ request: configuredRequest, agent: structuredClone(agent), actor, workspace: workspace ?? undefined,
      history, conversation: change?.commit.metadata ?? conversation, previousTurn, clientId: scope?.clientId, automationId });
    const names = prepared?.toolNames ?? agent.toolNames;
    const catalog = this.services.prepareTools ? await this.services.prepareTools(names, configuredRequest, agent) : this.services.tools.catalog(names);
    const now = Date.now();
    const run: RunRecord = { id: randomUUID(), requestKey: input.requestKey, conversationId: input.conversationId,
      actorId: actor.id, agentId: agent.id, workspaceId: workspace?.id, status: 'queued', createdAt: now,
      updatedAt: now, iteration: 0, catalogVersion: catalog.version, ...(automationId ? { automationId } : {}),
      ...(!source && typeof history.at(-1)?.runId === 'string' ? { continuationOf: history.at(-1)!.runId as string } : {}) };
    const message: PlatformMessage | undefined = source ? { ...change?.messageMetadata, ...prepared?.messageMetadata,
      ...(typeof source.deepSeekVisionTileSplit === 'boolean' ? { deepSeekVisionTileSplit: source.deepSeekVisionTileSplit } : {}),
      role: 'user', parts: structuredClone(prepared?.messageParts ?? source.parts), id: source.id || randomUUID(),
      timestamp: now, parentId: history.at(-1)?.id ?? null, actorId: actor.id, isUserInput: true, runId: run.id, requestKey: run.requestKey } : undefined;
    const selection = { ...modelSelection, promptContext: prepared?.promptContext, turnContext: prepared?.turnContext };
    const configuredAgent = { ...agent, systemPrompt: prepared?.systemPrompt ?? agent.systemPrompt };
    return { actor, workspace, state, catalog, modelSelection, prepared, run, message, selection, configuredAgent };
  }
  /** 预览与发送共用回合捕获和权限检查，但不创建任务与历史记录。 */
  async preview(input: StartRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope) {
    const turn = await this.prepareRun(structuredClone(input), change, scope ? structuredClone(scope) : undefined);
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
  private async begin(input: StartRunInput | ContinueRunInput, change?: PreparedConversationChange, scope?: RuntimeRunScope): Promise<RunRecord> {
    const { workspace, state, catalog, modelSelection, prepared, run, message, selection, configuredAgent } = await this.prepareRun(input, change, scope);
    const committed = await this.services.storage.commitConversation({ conversationId: input.conversationId,
      expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken, ...change?.commit,
      records: [...(change?.commit.records ?? []), { namespace: 'run-configurations', id: run.id, ownerId: run.conversationId,
        value: { ...modelSelection, ...(run.automationId ? { automationId: run.automationId } : {}),
          promptModeId: input.promptModeId ?? prepared?.messageMetadata?.promptModeId, workspace: workspace ?? null } }],
      startRun: { run, message } });
    const result = committed.run!;
    if (!result.created) return result.run;
    const controller = new AbortController();
    // Defer work one microtask so cancellation sees the run even when it arrives immediately.
    const execute = () => this.execute(run, structuredClone(configuredAgent), workspace ? structuredClone(workspace) : undefined, catalog, controller.signal, selection);
    const done = Promise.resolve().then(() => this.services.runInScope ? this.services.runInScope(run, execute) : execute())
      .finally(() => { this.active.delete(run.id); this.questions.clear(run.id); });
    this.active.set(run.id, { controller, done });
    // 对话事务和取消句柄都已建立，界面才开始订阅这一轮任务。
    this.notify({ type: 'run.created', runId: run.id, run: structuredClone(run), ...(message ? { message: structuredClone(message) } : {}) });
    void done.catch(() => undefined);
    return run;
  }

  private modelInput(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, actor: ActorIdentity, catalog: ToolCatalog,
    messages: PlatformMessage[], selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort' | 'promptContext' | 'turnContext'>, signal: AbortSignal): ModelInput {
    return { conversationId: run.conversationId, ...selection, systemPrompt: agent.systemPrompt, messages,
      taskContext: { actor: { id: actor.id, displayName: actor.displayName, role: actor.role }, workspace },
      tools: structuredClone(catalog.declarations), signal };
  }

  async wait(runId: string): Promise<RunRecord | null> {
    await this.active.get(runId)?.done;
    return this.services.storage.getRun(runId);
  }
  async cancel(runId: string, actorId: string): Promise<void> {
    const run = await this.services.storage.getRun(runId);
    const actor = await this.services.actor(actorId);
    if (!run || !actor || actor.revoked || (actor.role !== 'owner' && actor.id !== run.actorId)) throw new Error('This account cannot cancel the run.');
    this.active.get(runId)?.controller.abort(new Error('Cancelled by user.'));
  }
  /** 宿主生命周期端口，不作为远程 RPC 暴露；用于结束已确认归属的子任务。 */
  interrupt(runId: string, reason: Error): void { this.active.get(runId)?.controller.abort(reason); }
  async resolveApproval(approvalId: string, actorId: string, accepted: boolean): Promise<void> {
    const actor = await this.services.actor(actorId);
    if (!actor || actor.revoked || (actor.role !== 'owner' && !actor.effects.includes('administration'))) throw new Error('This account cannot approve operations.');
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Approval has expired or was already resolved.');
    this.approvals.delete(approvalId); pending.resolve(accepted);
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
    await Promise.allSettled([...this.active.values()].map(run => run.done));
  }

  private async execute(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, catalog: ToolCatalog, signal: AbortSignal, selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort' | 'promptContext' | 'turnContext'>): Promise<void> {
    try {
      signal.throwIfAborted();
      await this.event(run.id, 'run.started', {}, { status: 'running' });
      await this.services.beforeRun?.(run, workspace, signal);
      for (let iteration = 1; agent.maxIterations === -1 || iteration <= agent.maxIterations; iteration++) {
        signal.throwIfAborted();
        await this.services.deliverFeedback?.(run);
        await this.drainFeedback(run);
        const actor = await this.services.actor(run.actorId, run);
        if (!actor || actor.revoked) throw new Error('Run account was revoked.');
        const access = authorizeEffects(actor, [], workspace);
        if (access) throw new Error(access);
        let state = await this.services.storage.readConversationState(run.conversationId);
        run.iteration = iteration;
        await this.event(run.id, 'model.preparing', { iteration }, { iteration });
        let streamingEvent: Promise<void> | undefined;
        const request: ModelInput = { ...this.modelInput(run, agent, workspace, actor, catalog, state.history.messages, selection, signal),
          onRequest: async captured => {
            const id = `${run.id}:${iteration}`;
            await this.services.storage.putRecord({ namespace: 'model-requests', id, ownerId: run.conversationId,
              value: { ...captured, runId: run.id, iteration, capturedAt: Date.now(), turnContext: request.turnContext,
                // 手动总结复用最近真实调用的固定前缀；不保存信号、回调和认证头。
                prefix: { conversationId: request.conversationId, providerId: request.providerId, modelOverride: captured.model,
                  reasoningEffort: request.reasoningEffort, systemPrompt: request.systemPrompt, tools: request.tools,
                  promptContext: request.promptContext, taskContext: request.taskContext, turnContext: request.turnContext } } });
            await this.event(run.id, 'model.request', { iteration, requestId: id, protocol: captured.protocol, model: captured.model });
          },
          onDelta: parts => {
            if (!streamingEvent) {
              streamingEvent = this.event(run.id, 'model.streaming', { iteration });
              void streamingEvent.catch(() => undefined);
            }
            this.notify({ type: 'model.delta', runId: run.id, parts });
          },
        };
        const prepared = await this.services.prepareModel?.({ run, agent, workspace, iteration, input: request, history: state });
        if (prepared) { state = prepared.history; request.messages = prepared.messages; }
        const page = state.history;
        signal.throwIfAborted();
        await this.services.modelBoundary?.(run, workspace, signal, 'before', iteration);
        await this.event(run.id, 'model.started', { iteration });
        const generated = await this.services.models.generate(request).finally(async () => { await streamingEvent; });
        signal.throwIfAborted();
        let content: PlatformMessage = { ...generated, role: 'model', id: randomUUID(), runId: run.id, requestKey: run.requestKey,
          parentId: page.messages.at(-1)?.id ?? null, timestamp: Date.now() };
        if (this.services.transformOutput) content = await this.services.transformOutput({ run, message: content, request });
        const calls = this.calls(content);
        await this.services.storage.appendHistory(run.conversationId, [content], { expectedRevision: page.revision });
        this.notify({ type: 'message.persisted', runId: run.id, content: structuredClone(content) });
        await this.event(run.id, 'message.saved', { messageId: content.id }, { iteration });
        await this.services.modelBoundary?.(run, workspace, signal, 'after', iteration, content);
        if (!calls.length) {
          if (await this.services.deliverFeedback?.(run)) { this.notify({ type: 'model.continued', runId: run.id }); continue; }
          if (this.questions.hasFeedback(run.id)) { this.notify({ type: 'model.continued', runId: run.id }); await this.drainFeedback(run); continue; }
          if (this.questions.list(run.id).length) {
            this.notify({ type: 'model.continued', runId: run.id });
            await this.event(run.id, 'run.waiting_input', {}, { status: 'awaiting_input' });
            await this.questions.wait(run.id, signal);
            await this.event(run.id, 'run.started', { resumedAfterQuestion: true }, { status: 'running' });
            await this.drainFeedback(run); continue;
          }
          await this.event(run.id, 'run.completed', {}, { status: 'completed' }); return;
        }
        for (const call of calls) {
          const outcome = signal.aborted ? { success: false, code: 'CANCELLED', error: 'Task was cancelled before execution.' }
            : await this.executeTool(run, agent, workspace, catalog, call, signal, request);
          await this.saveToolResult(run, call, outcome);
        }
        const afterTools = await this.services.afterTools?.(run, workspace, signal, content);
        if (afterTools?.stop) {
          await this.event(run.id, 'run.completed', { reason: afterTools.reason ?? 'document_confirmation' }, { status: 'completed' }); return;
        }
      }
      throw new Error(`The configured iteration limit (${agent.maxIterations}) was reached.`);
    } catch (error) {
      await this.settleInterrupted(run, signal.aborted ? 'CANCELLED' : 'INTERRUPTED');
      await this.event(run.id, signal.aborted ? 'run.cancelled' : 'run.failed', { error: error instanceof Error ? error.message : String(error) }, {
        status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error),
      });
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
      const call = { id, name: source.name, args: source.args ?? {} };
      part.functionCall = { ...source, id };
      calls.push(call);
    }
    return calls;
  }

  private async executeTool(run: RunRecord, agent: AgentDefinition, workspace: WorkspaceDefinition | undefined, catalog: ToolCatalog, call: FunctionCall, signal: AbortSignal, selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>): Promise<ToolOutcome> {
    try {
      const entry = catalog.entries.get(call.name);
      if (!entry) return { success: false, code: 'UNKNOWN_TOOL', error: 'Tool is absent from the configured catalog.' };
      call = { ...call, args: normalizeToolArguments(call.args, entry.tool.declaration.parameters) };
      if (!entry.validate(call.args)) return { success: false, code: 'INVALID_ARGUMENTS', error: 'Tool arguments do not match its schema.' };
      const effects = entry.tool.effects(call.args);
      const actor = await this.services.actor(run.actorId, run);
      const denied = actor ? authorizeEffects(actor, effects, workspace, call.name) : 'Run account no longer exists.';
      if (denied || agent.toolApproval?.[call.name] === 'deny') return { success: false, code: 'PERMISSION_DENIED', error: denied ?? 'This tool is disabled by its approval rule.' };
      let approval = needsApproval(agent, call.name, effects);
      let reviewReason: string | undefined;
      const reviewed = !approval && !!agent.reviewerProviderId && (agent.reviewerToolNames
        ? agent.reviewerToolNames.includes(call.name) : effects.some(effect => !['public_read', 'workspace_read'].includes(effect)));
      if (reviewed) {
        if (!this.services.review) throw new Error('The configured operation reviewer is unavailable.');
        const review = await this.services.review({ agent, toolName: call.name, args: call.args, effects, signal });
        approval ||= review.requireApproval; reviewReason = review.reason;
      }
      if (approval && !await this.approve(run, call, effects, signal, reviewReason)) return { success: false, code: 'PERMISSION_DENIED', error: 'Operation was declined.' };
      // Grants may change while a task waits for approval or a reviewer.
      let current = actor;
      if (reviewed || approval) {
        current = await this.services.actor(run.actorId, run);
        const revoked = current ? authorizeEffects(current, effects, workspace, call.name) : 'Run account no longer exists.';
        if (revoked) return { success: false, code: 'PERMISSION_DENIED', error: revoked };
      }
      signal.throwIfAborted();
      await this.event(run.id, 'tool.started', { toolCallId: call.id, toolName: call.name });
      const context: ToolContext = { runId: run.id, conversationId: run.conversationId, toolCallId: call.id, iteration: run.iteration, actorId: run.actorId, workspace, signal,
        approvedByToolConfirmation: approval,
        actor: current ?? undefined,
        requestApproval: async reason => {
          if (approval) return true;
          if (!await this.approve(run, call, effects, signal, reason)) return false;
          const latest = await this.services.actor(run.actorId, run);
          const denied = latest ? authorizeEffects(latest, effects, workspace, call.name) : 'Run account no longer exists.';
          if (denied) throw new Error(denied);
          context.actor = latest ?? undefined;
          approval = true;
          context.approvedByToolConfirmation = true;
          return true;
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
      return await entry.tool.execute(call.args, context);
    } catch (error) {
      return { success: false, code: signal.aborted ? 'CANCELLED' : 'TOOL_FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async approve(run: RunRecord, call: FunctionCall, effects: ToolEffect[], signal: AbortSignal, reason?: string): Promise<boolean> {
    signal.throwIfAborted();
    const request: ApprovalRequest = { id: randomUUID(), runId: run.id, actorId: run.actorId,
      toolCallId: call.id, toolName: call.name, args: call.args, effects, workspaceId: run.workspaceId };
    let settle!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>(resolve => { settle = resolve; });
    const abort = () => settle(false);
    this.approvals.set(request.id, { request, resolve: settle });
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.event(run.id, 'approval.requested', { ...request, ...(reason ? { reason } : {}) }, { status: 'awaiting_approval' });
      const result = await accepted;
      await this.event(run.id, 'approval.resolved', { approvalId: request.id, accepted: result }, { status: 'running' });
      return result;
    } finally { signal.removeEventListener('abort', abort); this.approvals.delete(request.id); }
  }

  private async saveToolResult(run: RunRecord, call: FunctionCall, outcome: ToolOutcome): Promise<void> {
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

  private async settleInterrupted(run: RunRecord, code = 'INTERRUPTED'): Promise<void> {
    const page = await this.services.storage.readFullHistory(run.conversationId);
    const pending = new Map<string, FunctionCall>();
    for (const message of page.messages) {
      if (message.runId !== run.id) continue;
      for (const part of message.parts) {
        const call = part.functionCall as FunctionCall | undefined;
        const response = part.functionResponse as { id: string } | undefined;
        if (call && message.role === 'model') pending.set(call.id, call);
        if (response) pending.delete(response.id);
      }
    }
    for (const call of pending.values()) await this.saveToolResult(run, call, { success: false, code, error: 'Execution was interrupted; side effects are not automatically retried.' });
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
