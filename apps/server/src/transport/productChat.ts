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
/** Map core run events to the existing chat UI stream contract without owning execution. */
export class ProductChat {
  private readonly streams = new Map<string, ChatStream>();
  constructor(private readonly app: PlatformApplication) {
    app.subscribe(notification => this.notification(notification as Record<string, any>));
  }
  private createStream(conversationId: string, runId?: string): ChatStream {
    return { conversationId, runId, clients: new Map(), remaining: new Set(), results: [], resultContents: [], accumulator: new StreamAccumulator(), phase: 'model' };
  }
  async start(client: ClientSession, data: Record<string, any>, preferences: ProductSettingsDraft, mode: 'send' | 'continue' | 'reroll' | 'edit' = 'send'): Promise<unknown> {
    if (!data.streamId || (!data.configId && !(mode === 'edit' && data.mode === 'keep'))) throw new Error('请选择渠道和模型。');
    const conversation = await this.app.conversation(client.actorId, data.conversationId);
    const requestKey = `desktop:${data.streamId}`;
    const existing = await this.app.storage.getRunByRequestKey(requestKey);
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
    const stream = this.createStream(conversation.id);
    stream.clients.set(client.clientId, { streamId: data.streamId, background: false });
    const input = chatRunInput(client, data, preferences, conversation, requestKey);
    let run: RunRecord;
    const scope = { clientId: client.clientId };
    if (mode === 'send' && data.hiddenFunctionResponse) {
      const change = await new ArtifactApproval(this.app).prepare(client.actorId, conversation.id, data.hiddenFunctionResponse);
      run = await this.app.runtime.continue({ ...input, expectedRevision: change.state.history.revision }, change, scope);
    } else if (mode === 'send') run = await this.app.runtime.start({ ...input, message: userMessage }, undefined, scope);
    else if (mode === 'continue') {
      const state = await this.app.conversations.read(client.actorId, conversation.id);
      run = await this.app.runtime.continue({ ...input, expectedRevision: state.history.revision }, undefined, scope);
    } else if (mode === 'reroll') {
      const change = await this.app.conversations.reroll(client.actorId, conversation.id, data.assistantNodeId, input.requestKey);
      run = await this.app.runtime.continue({ ...input, expectedRevision: change.state.history.revision }, change, scope);
    } else {
      const edit = await this.app.conversations.edit(client.actorId, conversation.id, data.userNodeId ?? data.messageId, parts, input.requestKey,
        data.mode === 'keep' ? 'keep' : 'branch', { ...vision, preserveAttachments: data.attachments === undefined });
      if (!edit.message) {
        const result = await this.app.conversations.commit(edit.change);
        const userContent = edit.change.commit.messages?.find(message => message.id === (data.userNodeId ?? data.messageId));
        this.emit(stream, { type: 'complete' }); return { ...result, ...(userContent ? { userContent: displayCharacterContent(userContent) } : {}) };
      }
      run = await this.app.runtime.start({ ...input, message: edit.message }, edit.change, scope);
    }
    stream.runId = run.id;
    const current = this.streams.get(run.id) ?? stream;
    current.clients.set(client.clientId, { streamId: data.streamId, background: false });
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
    stream.clients.set(client.clientId, { streamId, background: true });
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
   * 后再返回。等待带超时兜底：任务异常挂死时按既有语义继续，不让停止操作本身卡住。
   */
  async cancel(client: ClientSession, conversationId: string): Promise<unknown> {
    await this.app.conversation(client.actorId, conversationId);
    const runs = await this.app.storage.listRuns({ conversationId, activeOnly: true });
    for (const run of runs) await this.app.runtime.cancel(run.id, client.actorId);
    await this.waitForRelease(runs.map(run => run.id));
    return { success: true };
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
      if (!active.length) return { idle: true };
      if (Date.now() >= deadline) return { idle: false };
      // 本进程的运行控制器退出时会立即唤醒；不属于本进程的遗留活跃记录由固定间隔退避兜底。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pause = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(100, deadline - Date.now())); });
      try {
        await Promise.race([
          this.app.runtime.wait(active[0].id).then(run => run && ['queued', 'running', 'awaiting_approval', 'awaiting_input'].includes(run.status) ? pause : undefined),
          pause,
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
  /** 等待给定任务退出（超时视同已退出，按调用方既有语义继续）。 */
  private async waitForRelease(runIds: string[]): Promise<void> {
    if (!runIds.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(runIds.map(runId => this.app.runtime.wait(runId))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async confirm(client: ClientSession, data: Record<string, any>): Promise<unknown> {
    await this.app.conversation(client.actorId, data.conversationId);
    for (const response of data.toolResponses ?? []) {
      const approval = this.app.runtime.pendingApprovals().find(item => item.toolCallId === response.id
        && (response.approvalId === undefined || item.id === response.approvalId));
      if (!approval) {
        if (response.approvalId !== undefined) throw new Error('这个确认请求已经结束。');
        continue;
      }
      if (approval.choices && response.approvalId !== approval.id) throw new Error('请选择当前请求的具体选项。');
      const run = await this.app.storage.getRun(approval.runId);
      if (run?.conversationId !== data.conversationId) throw new Error('审批不属于当前对话。');
      const stream = this.streams.get(approval.runId);
      if (stream && typeof data.streamId === 'string') {
        stream.clients.set(client.clientId, { streamId: data.streamId, background: false });
      }
      await this.app.runtime.resolveApproval(approval.id, client.actorId, response.confirmed === true, response.choiceId);
    }
    return { success: true };
  }
  private emitClient(stream: ChatStream, clientId: string, chunk: Record<string, unknown>): void {
    const client = stream.clients.get(clientId); if (!client) return;
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
