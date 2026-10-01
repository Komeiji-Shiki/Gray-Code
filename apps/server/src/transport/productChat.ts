import { ArtifactApproval } from '../artifacts/approval';
import { chatRunInput, chatUserMessage } from './chatInput';
import { StreamAccumulator } from '../../../../backend/modules/channel/StreamAccumulator';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../../../../backend/core/streamConstants';
import { PLACEHOLDER_CONVERSATION_TITLES, deriveConversationTitle } from '../conversations/autoTitles';
import type { PlatformConversation, PlatformMessage, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';
import type { ProductSettingsDraft } from '../settings/product';

function displayCharacterContent(message: PlatformMessage): PlatformMessage {
  const { characterTurn, ...content } = message;
  return { ...content, ...(characterTurn ? { characterMode: true } : {}) };
}
interface ChatStream {
  clients: Map<string, { streamId: string; background: boolean }>;
  runId?: string;
  conversationId: string;
  content?: PlatformMessage;
  accumulator: StreamAccumulator;
  phase: 'model' | 'tools';
  remaining: Set<string>;
  results: { id: string; name: string; result: unknown }[];
  resultContents: PlatformMessage[];
}
interface PendingChatStart { actorId: string; controller: AbortController; done: Promise<void>; runId?: string }
/** Map core run events to the existing chat UI stream contract without owning execution. */
export class ProductChat {
  private readonly streams = new Map<string, ChatStream>();
  private readonly starts = new Map<string, Set<PendingChatStart>>();
  private readonly disconnectedClients = new Set<string>();
  constructor(private readonly app: PlatformApplication) {
    app.subscribe(notification => this.notification(notification as Record<string, any>));
  }
  private createStream(conversationId: string, runId?: string): ChatStream {
    return { conversationId, runId, clients: new Map(), remaining: new Set(), results: [], resultContents: [], accumulator: new StreamAccumulator(), phase: 'model' };
  }
  hasPendingStarts(conversationId?: string): boolean {
    return conversationId === undefined ? this.starts.size > 0 : !!this.starts.get(conversationId)?.size;
  }
  clientConnected(clientId: string): void { this.disconnectedClients.delete(clientId); }
  clientClosed(clientId: string): void {
    this.disconnectedClients.add(clientId);
    for (const stream of this.streams.values()) stream.clients.delete(clientId);
  }
  /** 在客户端交互队列之前登记，停止也能覆盖尚未开始准备的输入。 */
  queueStart(client: ClientSession, conversationId: string, operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const pending: PendingChatStart = { actorId: client.actorId, controller: new AbortController(), done: Promise.resolve() };
    const entries = this.starts.get(conversationId) ?? new Set<PendingChatStart>();
    entries.add(pending); this.starts.set(conversationId, entries);
    const result = Promise.resolve().then(() => { pending.controller.signal.throwIfAborted(); return operation(pending.controller.signal); })
      .then(value => {
        const runId = (value as { runId?: unknown } | null)?.runId;
        if (typeof runId === 'string') pending.runId = runId;
        return value;
      })
      .finally(() => {
        entries.delete(pending); if (!entries.size) this.starts.delete(conversationId);
        // 准备失败或提交前取消没有 run 事件，桌面仍需重新检查已请求的退出。
        this.app.publish({ type: 'chat.preparation.changed', conversationId });
      });
    pending.done = result.then(() => {}, () => {});
    return result;
  }
  async start(client: ClientSession, data: Record<string, any>, preferences: ProductSettingsDraft, mode: 'send' | 'continue' | 'reroll' | 'edit' = 'send', signal?: AbortSignal): Promise<unknown> {
    if (!signal) return this.queueStart(client, data.conversationId, signal => this.startRun(client, data, preferences, mode, signal));
    return this.startRun(client, data, preferences, mode, signal);
  }
  private async startRun(client: ClientSession, data: Record<string, any>, preferences: ProductSettingsDraft, mode: 'send' | 'continue' | 'reroll' | 'edit', signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!data.streamId || (!data.configId && !(mode === 'edit' && data.mode === 'keep'))) throw new Error('请选择渠道和模型。');
    const conversation = await this.app.conversation(client.actorId, data.conversationId);
    const requestKey = `desktop:${data.streamId}`;
    const existing = await this.app.storage.getRunByRequestKey(requestKey);
    signal.throwIfAborted();
    if (existing) {
      if (existing.actorId !== client.actorId || existing.conversationId !== conversation.id) throw new Error('请求标识已被其他任务使用。');
      return { success: true, runId: existing.id };
    }
    const text = mode === 'edit' ? data.newText : data.message;
    const userMessage = chatUserMessage(data, text);
    const parts = userMessage.parts;
    const vision = typeof data.deepSeekVisionTileSplit === 'boolean' ? { deepSeekVisionTileSplit: data.deepSeekVisionTileSplit } : {};
    if (mode === 'send' && !parts.length && !data.hiddenFunctionResponse) throw new Error('请输入消息或添加附件。');
    if (mode === 'send' && !data.hiddenFunctionResponse) await this.applyAutoTitle(conversation, text);
    signal.throwIfAborted();
    const stream = this.createStream(conversation.id);
    if (!this.disconnectedClients.has(client.clientId)) stream.clients.set(client.clientId, { streamId: data.streamId, background: false });
    const input = chatRunInput(client, data, preferences, conversation, requestKey);
    let run: RunRecord;
    const scope = { clientId: client.clientId, signal };
    if (mode === 'send' && data.hiddenFunctionResponse) {
      const change = await new ArtifactApproval(this.app).prepare(client.actorId, conversation.id, data.hiddenFunctionResponse);
      signal.throwIfAborted();
      run = await this.app.runtime.continue({ ...input, expectedRevision: change.state.history.revision }, change, scope);
    } else if (mode === 'send') run = await this.app.runtime.start({ ...input, message: userMessage }, undefined, scope);
    else if (mode === 'continue') {
      const state = await this.app.conversations.read(client.actorId, conversation.id);
      signal.throwIfAborted();
      run = await this.app.runtime.continue({ ...input, expectedRevision: state.history.revision }, undefined, scope);
    } else if (mode === 'reroll') {
      const change = await this.app.conversations.reroll(client.actorId, conversation.id, data.assistantNodeId, input.requestKey);
      signal.throwIfAborted();
      run = await this.app.runtime.continue({ ...input, expectedRevision: change.state.history.revision }, change, scope);
    } else {
      const edit = await this.app.conversations.edit(client.actorId, conversation.id, data.userNodeId ?? data.messageId, parts, input.requestKey,
        data.mode === 'keep' ? 'keep' : 'branch', { ...vision, preserveAttachments: data.attachments === undefined });
      signal.throwIfAborted();
      if (!edit.message) {
        const result = await this.app.conversations.commit(edit.change);
        const userContent = edit.change.commit.messages?.find(message => message.id === (data.userNodeId ?? data.messageId));
        this.emit(stream, { type: 'complete' }); return { ...result, ...(userContent ? { userContent: displayCharacterContent(userContent) } : {}) };
      }
      run = await this.app.runtime.start({ ...input, message: edit.message }, edit.change, scope);
    }
    stream.runId = run.id;
    const current = this.streams.get(run.id) ?? stream;
    if (!this.disconnectedClients.has(client.clientId)) current.clients.set(client.clientId, { streamId: data.streamId, background: false });
    this.streams.set(run.id, current);
    const page = mode === 'edit' || (conversation.custom as Record<string, unknown> | undefined)?.platformMode === 'character' && mode === 'send'
      ? await this.app.storage.readHistory(conversation.id, { limit: 20 }) : undefined;
    const userContent = page?.messages.find(message => message.runId === run.id && message.isUserInput);
    return { success: true, runId: run.id, ...(userContent ? { userContent: displayCharacterContent(userContent) } : {}) };
  }
  followBackground(run: RunRecord): void {
    if (this.streams.has(run.id)) return;
    const stream = this.createStream(run.conversationId, run.id);
    this.streams.set(run.id, stream);
    this.emit(stream, { type: 'chunk', chunk: { delta: [], done: false } });
  }

  /**
   * 首条消息自动命名。
   *
   * 独立宿主新建对话时先落库占位标题（ui.mode.new / conversation.createConversation），首条消息
   * 不再经过「以消息创建对话」的旧流程，标题会一直停在「新对话」。这里在首个回合写入历史前，
   * 把仍是占位标题（或空标题）的空对话替换为消息摘要，并广播 metadataOnly 变更让侧栏/标签页刷新。
   */
  private async applyAutoTitle(conversation: PlatformConversation, text: unknown): Promise<void> {
    const title = deriveConversationTitle(text);
    const current = typeof conversation.title === 'string' ? conversation.title.trim() : '';
    if (!title || (current && !PLACEHOLDER_CONVERSATION_TITLES.has(current))) return;
    const info = await this.app.storage.getConversationInfo(conversation.id);
    const latestTitle = info?.metadata.title?.trim();
    if (!info || info.messageCount !== 0 || latestTitle && !PLACEHOLDER_CONVERSATION_TITLES.has(latestTitle)) return;
    // 自动标题只能修改刚读取的占位元数据，不能覆盖并发重命名或新回合。
    try {
      await this.app.storage.commitConversation({ conversationId: conversation.id, expectedRevision: info.historyRevision,
        expectedMetadataToken: info.metadataToken, metadata: { ...info.metadata, title } });
    } catch (error) {
      if (['REVISION_CONFLICT', 'STORAGE_BUSY'].includes((error as { code?: string }).code ?? '')) return;
      throw error;
    }
    this.app.productUi.conversations.clearMetadataCache();
    this.app.publish({ type: 'conversation.changed', conversationId: conversation.id, metadataOnly: true });
  }
  async resumeConversationStream(client: ClientSession, conversationId: string): Promise<{ active: boolean; latestMessageId?: string }> {
    await this.app.conversation(client.actorId, conversationId);
    const runs = await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 });
    const run = runs[0];
    if (!run) {
      const history = await this.app.storage.readHistory(conversationId, { limit: 1 });
      return { active: false, latestMessageId: history.messages.at(-1)?.id };
    }
    const stream = this.streams.get(run.id);
    if (!stream) return { active: false };
    const streamId = `background:${run.id}`;
    if (!this.disconnectedClients.has(client.clientId)) stream.clients.set(client.clientId, { streamId, background: true });
    const content = stream.phase === 'tools' && stream.content ? stream.content : {
      ...stream.accumulator.getStreamingContent(), id: `live:${run.id}:${run.iteration}`, role: 'model', runId: run.id,
    };
    this.emitClient(stream, client.clientId, { type: 'chunk', resumeSnapshot: true, chunk: { delta: [], done: false, contentSnapshot: content } });
    if (stream.phase === 'tools' && stream.content) {
      this.emitClient(stream, client.clientId, { type: 'toolsExecuting', toolsExecuting: true, content: stream.content });
      for (const result of stream.results) this.emitClient(stream, client.clientId, { type: 'toolStatus', toolStatus: true,
        tool: { id: result.id, name: result.name, result: result.result, status: (result.result as any)?.success === false ? 'error' : 'success' } });
      const approvals = this.app.runtime.pendingApprovals().filter(item => item.runId === run.id);
      if (approvals.length) this.emitClient(stream, client.clientId, { type: 'awaitingConfirmation', keepStreamOpen: true, content: stream.content,
        toolResults: stream.results, toolResultContents: stream.resultContents, pendingToolCalls: approvals.map(item => ({ id: item.toolCallId, name: item.toolName, args: item.args,
          approvalId: item.id, approvalReason: item.reason, approvalChoices: item.choices })) });
    }
    return { active: true };
  }
  /**
   * 停止对话内的活跃任务。
   *
   * 取消只负责发起中止：任务还要结算工具结果、写下终态事件才算真正退出，而一个对话
   * 同时只允许一个活跃任务（RunRepository.create 在对话仍有活跃任务时抛 STORAGE_BUSY）。
   * 共享前端「替换当前回合」的流程——停止后立即发新消息、排队消息在动作边界提前投递、
   * 后台回执回流——都直接依赖「cancelStream 返回即旧回合已退出」，因此这里等任务退出
   * 后再返回。准备和排队中的输入也属于此生命周期；超时必须报告未释放。
   */
  async cancel(client: ClientSession, conversationId: string, timeoutMs = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    // 先捕获受理时的对象和存储读请求；异步授权、结算期间进入的新回合不属于这次停止。
    const acceptedStarts = [...(this.starts.get(conversationId) ?? [])];
    const acceptedRunIds = this.app.runtime.activeRunIds(conversationId);
    // 本进程的运行按各自归属授权后立即中止，不等待下方经过存储线程的会话与任务查询。
    const immediate = Promise.all(acceptedRunIds.map(runId => this.app.runtime.cancel(runId, client.actorId)));
    void immediate.catch(() => {}); // 会话授权先失败时不再等待它，仍需处理它的失败。
    const snapshot = this.app.storage.listRuns({ conversationId, activeOnly: true });
    void snapshot.catch(() => {}); // 授权拒绝时不会再等待这个只读请求，仍需处理它的失败。
    await this.app.conversation(client.actorId, conversationId);
    const actor = this.app.actor(client.actorId);
    if (!actor || actor.revoked) throw new Error('This account cannot cancel the run.');
    const starts = acceptedStarts.filter(pending => actor.role === 'owner' || pending.actorId === actor.id);
    for (const pending of starts) pending.controller.abort(Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED_ERROR' }));
    await immediate;
    const runs = await snapshot;
    const runIds = [...new Set([...runs.map(run => run.id), ...acceptedRunIds])];
    const accepted = new Set(acceptedRunIds);
    for (const runId of runIds) if (!accepted.has(runId)) await this.app.runtime.cancel(runId, client.actorId);
    const released = await this.waitForRelease(runIds, starts, client.actorId, Math.max(0, deadline - Date.now()));
    return released ? { success: true } : { success: false, code: 'RUN_CANCEL_TIMEOUT' };
  }
  /**
   * 等待对话空闲。
   *
   * 共享前端在旧回合收尾窗口（后台回执回流）或同会话存在其他入口任务时，用它决定何时
   * 插入新回合，否则新任务会被 STORAGE_BUSY 拒绝。以运行控制器为生命周期事实来源等待，
   * 达到时限则按「不空闲」返回，由调用方决定后续动作。
   */
  async awaitIdle(conversationId: string, timeoutMs = OLD_STREAM_EXIT_WAIT_TIMEOUT_MS): Promise<{ idle: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const active = await this.app.storage.listRuns({ conversationId, activeOnly: true, limit: 1 });
      const starts = [...(this.starts.get(conversationId) ?? [])];
      const runIds = [...new Set([...this.app.runtime.activeRunIds(conversationId), ...active.map(run => run.id)])];
      if (!active.length && !runIds.length && !starts.length) return { idle: true };
      if (Date.now() >= deadline) return { idle: false };
      // 本进程的运行控制器退出时会立即唤醒；不属于本进程的遗留活跃记录由固定间隔退避兜底。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pause = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(100, deadline - Date.now())); });
      try {
        await Promise.race([
          Promise.all([...starts.map(pending => pending.done), ...runIds.map(runId => this.app.runtime.wait(runId))])
            .then(runs => active.length && !starts.length && runs.some(run => run && ['queued', 'running', 'awaiting_approval', 'awaiting_input'].includes(run.status)) ? pause : undefined),
          pause,
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
  /** 终态事件与 finally 清理都完成后才释放；存储失败继续交给调用方。 */
  private async waitForRelease(runIds: string[], starts: PendingChatStart[], actorId: string, timeoutMs: number): Promise<boolean> {
    if (!runIds.length && !starts.length) return true;
    const deadline = Date.now() + timeoutMs; const targets = new Set(runIds);
    const release = async () => {
      await Promise.all(starts.map(async pending => {
        await pending.done;
        // 旧请求可能在快照后才提交；只接续该请求返回的任务身份，不再枚举整个会话。
        if (pending.runId) { targets.add(pending.runId); await this.app.runtime.cancel(pending.runId, actorId); }
      }));
      for (;;) {
        // 提交前 wait(runId) 可能只读到 queued，须在旧请求返回后等待其实际控制器退出。
        const runs = await Promise.all([...targets].map(runId => this.app.runtime.wait(runId)));
        if (runs.every(run => !run || !['queued', 'running', 'awaiting_approval', 'awaiting_input'].includes(run.status))) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        release(),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async confirm(client: ClientSession, data: Record<string, any>): Promise<unknown> {
    await this.app.conversation(client.actorId, data.conversationId);
    if (!Array.isArray(data.toolResponses) || !data.toolResponses.length) throw new Error('请选择当前工具的确认请求。');
    const seen = new Set<string>();
    const requests = data.toolResponses.map((response: Record<string, unknown>) => {
      // toolCallId 由模型提供，后续运行可能复用；它不能替代这一轮审批的身份。
      if (!response || typeof response.approvalId !== 'string' || !response.approvalId
        || typeof response.id !== 'string' || typeof response.name !== 'string') throw new Error('确认请求缺少审批身份，请刷新后重试。');
      if (typeof response.confirmed !== 'boolean') throw new Error('请明确接受或拒绝操作。');
      if (response.choiceId !== undefined && typeof response.choiceId !== 'string') throw new Error('请选择这个请求提供的具体选项。');
      if (seen.has(response.approvalId)) throw new Error('同一审批请求不能重复提交。');
      seen.add(response.approvalId);
      const approval = this.app.runtime.pendingApprovals().find(item => item.id === response.approvalId);
      if (!approval) throw new Error('这个确认请求已经结束，请刷新当前任务状态。');
      if (approval.toolCallId !== response.id || approval.toolName !== response.name
        || response.runId !== undefined && response.runId !== approval.runId
        || data.runId !== undefined && data.runId !== approval.runId) throw new Error('审批不属于当前工具或任务，请刷新后重试。');
      return { approval, confirmed: response.confirmed, choiceId: response.choiceId };
    });
    // 整批先验证归属，不因后一条无效而提前应用前一条确认。
    for (const { approval } of requests) {
      const run = await this.app.storage.getRun(approval.runId);
      if (run?.conversationId !== data.conversationId) throw new Error('审批不属于当前对话。');
    }
    for (const { approval, confirmed, choiceId } of requests) {
      await this.app.runtime.resolveApproval(approval.id, client.actorId, confirmed, choiceId);
      // 只有真正消耗原审批的回执才能重绑流。失败、过期和并发重复回执不能抢走终态。
      // runtime 在发布后续流事件前会等待 approval.resolved 的存储提交。
      const stream = this.streams.get(approval.runId);
      if (stream && typeof data.streamId === 'string' && data.streamId) {
        stream.clients.set(client.clientId, { streamId: data.streamId, background: false });
      }
    }
    return { success: true };
  }
  private emitClient(stream: ChatStream, clientId: string, chunk: Record<string, unknown>): void {
    const client = stream.clients.get(clientId); if (!client || this.disconnectedClients.has(clientId)) return;
    this.app.publish({ type: 'ui.message', runId: stream.runId, clientId,
      message: { type: 'streamChunk', data: { ...chunk, backgroundRun: client.background, conversationId: stream.conversationId, streamId: client.streamId, createdAt: Date.now() } } });
  }
  private emit(stream: ChatStream, chunk: Record<string, unknown>): void {
    for (const clientId of stream.clients.keys()) this.emitClient(stream, clientId, chunk);
    if (stream.runId) this.app.publish({ type: 'ui.message', runId: stream.runId, excludeClientIds: [...stream.clients.keys()],
      message: { type: 'streamChunk', data: { ...chunk, backgroundRun: true, conversationId: stream.conversationId, streamId: `background:${stream.runId}`, createdAt: Date.now() } } });
  }
  private notification(notification: Record<string, any>): void {
    const runId = notification.runId ?? notification.event?.runId;
    if (notification.type === 'ui.message') return;
    if (notification.type === 'run.created') {
      const run = notification.run as RunRecord;
      if (this.app.subagents.childConversationIds().has(run.conversationId)) return;
      this.followBackground(run);
      if (notification.message) this.emit(this.streams.get(runId)!, { type: 'userFeedback', feedbackContent: displayCharacterContent(notification.message) });
      return;
    }
    const stream = this.streams.get(runId);
    if (!stream) return;
    if (notification.type === 'model.delta') {
      stream.accumulator.add({ delta: notification.parts, done: false });
      this.emit(stream, { type: 'chunk', chunk: { delta: notification.parts, done: false } }); return;
    }
    if (notification.type === 'model.continued') { this.emit(stream, { type: 'toolIteration', content: stream.content, toolResults: [] }); return; }
    if (notification.type === 'message.persisted') {
      const content = displayCharacterContent(notification.content as PlatformMessage);
      if (content.role === 'model') {
        stream.content = content;
        stream.phase = 'tools';
        stream.remaining = new Set(content.parts.flatMap(part => part.functionCall ? [(part.functionCall as { id: string }).id] : []));
        stream.results = [];
        stream.resultContents = [];
        if (stream.remaining.size) this.emit(stream, { type: 'toolsExecuting', toolsExecuting: true, content });
      } else if (content.isFunctionResponse) {
        stream.resultContents.push(content);
        for (const part of content.parts) {
          const result = part.functionResponse as { id: string; name: string; response: Record<string, any> } | undefined;
          if (!result) continue;
          stream.results.push({ id: result.id, name: result.name, result: result.response });
          stream.remaining.delete(result.id);
          this.emit(stream, { type: 'toolStatus', toolStatus: true, tool: { id: result.id, name: result.name,
            status: result.response.success === false ? 'error' : 'success', result: result.response } });
        }
        if (!stream.remaining.size && stream.content) this.emit(stream, { type: 'toolIteration', content: stream.content, toolResults: stream.results, toolResultContents: stream.resultContents });
      } else if (content.userFeedback) {
        this.emit(stream, { type: 'userFeedback', feedbackContent: content });
      }
      return;
    }
    if (notification.type !== 'event') return;
    const event = notification.event;
    if (event.type === 'model.started') {
      stream.phase = 'model'; stream.content = undefined; stream.accumulator.reset();
    } else if (event.type === 'context.summary.started' || event.type === 'context.summary.failed') {
      this.emit(stream, { type: 'autoSummaryStatus', autoSummaryStatus: true,
        status: event.type.endsWith('started') ? 'started' : 'failed', message: event.payload.message });
    } else if (event.type === 'context.summary.completed') {
      this.emit(stream, { type: 'autoSummary', autoSummary: true, ...event.payload });
      this.emit(stream, { type: 'autoSummaryStatus', autoSummaryStatus: true, status: 'completed' });
    } else if (event.type === 'approval.requested') {
      this.emit(stream, { type: 'awaitingConfirmation', keepStreamOpen: true, content: stream.content, toolResults: stream.results, toolResultContents: stream.resultContents,
        pendingToolCalls: this.app.runtime.pendingApprovals().filter(approval => approval.runId === runId)
          .map(approval => ({ id: approval.toolCallId, name: approval.toolName, args: approval.args,
            approvalId: approval.id, approvalReason: approval.reason, approvalChoices: approval.choices })) });
    } else if (event.type === 'approval.resolved' && typeof event.payload.choiceId === 'string') {
      this.emit(stream, { type: 'toolStatus', toolStatus: true, tool: { id: event.payload.toolCallId,
        name: event.payload.toolName, status: 'executing' } });
    } else if (event.type === 'tool.started') {
      this.emit(stream, { type: 'toolStatus', toolStatus: true, tool: { id: event.payload.toolCallId,
        name: event.payload.toolName, args: event.payload.args, status: 'executing' } });
    } else if (event.type === 'run.completed') {
      this.emit(stream, { type: 'complete', content: stream.content }); this.streams.delete(runId);
    } else if (event.type === 'run.cancelled') {
      this.emit(stream, { type: 'cancelled', content: stream.content }); this.streams.delete(runId);
    } else if (event.type === 'run.failed' || event.type === 'run.interrupted') {
      // The history transaction already committed. Retry continues that history, without
      // repeating the edit/reroll operation or replaying its previous tool side effects.
      this.emit(stream, { type: 'error', ...(stream.content?.incompleteReason ? { content: stream.content } : {}),
        error: { code: 'API_ERROR', message: event.payload.error ?? event.payload.reason ?? '任务未完成，请检查连接和配置。' } });
      this.streams.delete(runId);
    }
  }
}
