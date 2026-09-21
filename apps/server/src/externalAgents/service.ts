import { createHash, randomUUID } from 'node:crypto';
import type { ToolContext } from '@graycode/core';
import type { ExternalAgentEvent, ExternalAgentProfile, ExternalAgentSession, ToolOutcome, WorkspaceDefinition } from '@graycode/contracts';
import type { AgentRequestMethod, AgentRequestParamsByMethod, AgentRequestResponsesByMethod, ContentBlock, NewSessionRequest, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { PlatformApplication } from '../application';
import { workspaceDirectoryKey } from '../workspace/identity';
import { openAcpClient, type AcpClient } from './client';
import { externalAgentTool } from './tool';

const sessionsNamespace = 'external-agent-sessions';
const eventsNamespace = 'external-agent-events';
const operationsNamespace = 'external-agent-operations';
interface SessionRecord extends ExternalAgentSession {
  conversationId: string; profile: ExternalAgentProfile; workspace: WorkspaceDefinition; parentSessionId?: string;
}
interface Operation {
  id: string; fingerprint: string; sessionId: string; runId: string; status: 'running' | 'completed' | 'unknown'; outcome?: ToolOutcome;
}
interface ActiveOperation {
  context: ToolContext; signal: AbortSignal; cancel: AbortController; output: string[]; images: NonNullable<ToolOutcome['attachments']>;
  replay: boolean; text?: { type: string; chunks: string[]; bytes: number }; timer?: ReturnType<typeof setTimeout>;
  writes: Promise<void>; permissions: Promise<unknown>;
}
interface LiveSession { record: SessionRecord; client?: AcpClient; active?: ActiveOperation; disposing?: Promise<void> }
class ExecutionUnknown extends Error {}

/** 外部代理会话独立于模型协议，通过现有工具执行、确认、取消和历史路径交付结果。 */
export class ExternalAgents {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly operations = new Map<string, { fingerprint: string; promise: Promise<ToolOutcome> }>();
  private readonly unsubscribe: () => void;
  private closing = false;
  constructor(private readonly app: PlatformApplication) {
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed') this.refreshTools();
      if (event.type === 'conversation.changed' && typeof event.conversationId === 'string')
        void this.conversationChanged(event.conversationId).catch(error => console.error('外部代理会话清理失败：', error));
    });
  }
  private profiles() { return this.app.settings.snapshot().settings.externalAgents ?? []; }
  private refreshTools() {
    const enabled = this.profiles().some(profile => profile.enabled) || this.sessions.size > 0;
    this.app.tools.replaceNamespace('coding_agent', enabled ? [externalAgentTool(this)] : []);
  }
  async initialize() {
    for (const id of await this.app.storage.listRecords(sessionsNamespace)) {
      const record = await this.app.storage.getRecord(sessionsNamespace, id) as SessionRecord;
      if (record.status === 'running') {
        record.status = 'interrupted'; record.error = '应用重新启动，未自动重放上次请求。';
        await this.save(record);
      }
      this.sessions.set(id, { record });
    }
    this.refreshTools();
  }
  private async save(record: SessionRecord) {
    record.updatedAt = Date.now();
    await this.app.storage.putRecord({ namespace: sessionsNamespace, id: record.id, ownerId: record.conversationId, value: record });
  }
  private summary(record: SessionRecord): ExternalAgentSession {
    const { profile: _profile, workspace: _workspace, conversationId: _conversation, parentSessionId: _parent, ...value } = record;
    return structuredClone(value);
  }
  private async owned(id: string, context: ToolContext, sameConversation = true): Promise<LiveSession> {
    const live = this.sessions.get(id);
    if (!live || live.record.actorId !== context.actorId) throw new Error('外部代理会话不存在，或不属于当前账号。');
    await this.app.conversation(context.actorId, live.record.conversationId);
    this.app.workspace(context.actorId, live.record.workspaceId, ['workspace_read']);
    if (sameConversation && (live.record.conversationId !== context.conversationId || !context.workspace
      || workspaceDirectoryKey(live.record.directory) !== workspaceDirectoryKey(context.workspace.directory)))
      throw new Error('请在这个代理会话原来的任务和工作区中继续；其他任务可以明确派生新会话。');
    return live;
  }
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    if (this.closing) throw new Error('外部代理服务正在关闭。');
    const action = String(args.action);
    if (action === 'list') return { success: true, data: {
      profiles: this.profiles().filter(profile => profile.enabled).map(({ id, name }) => ({ id, name })),
      sessions: [...this.sessions.values()].filter(value => value.record.actorId === context.actorId && value.record.conversationId === context.conversationId)
        .map(value => this.summary(value.record)),
    } };
    if (action === 'events') {
      const live = await this.owned(String(args.sessionId), context, false);
      const after = Number(args.afterSequence ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('事件位置必须是非负整数。');
      const events = await Promise.all(Array.from({ length: Math.min(100, Math.max(0, live.record.lastEvent - after)) }, (_, i) =>
        this.app.storage.getRecord(eventsNamespace, `${live.record.id}:${String(after + i + 1).padStart(12, '0')}`)));
      return { success: true, data: { session: this.summary(live.record), events, hasMore: after + events.length < live.record.lastEvent } };
    }
    if (!context.conversationId || !context.workspace || !context.toolCallId) throw new Error('编码代理操作需要工作区和完整任务调用身份。');
    const id = createHash('sha256').update(JSON.stringify([context.runId, context.iteration, context.toolCallId])).digest('hex');
    const fingerprint = JSON.stringify([action, args.profileId, args.sessionId, args.prompt, args.images, args.configId, args.value, args.modeId, context.workspace.id]);
    const pending = this.operations.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error('同一调用身份不能改用另一组代理参数。');
      return pending.promise;
    }
    const operation = this.perform(id, fingerprint, action, args, context);
    this.operations.set(id, { fingerprint, promise: operation });
    try { return await operation; } finally { if (this.operations.get(id)?.promise === operation) this.operations.delete(id); }
  }
  private async perform(id: string, fingerprint: string, action: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const previous = await this.app.storage.getRecord(operationsNamespace, id) as Operation | null;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('同一调用身份不能改用另一组代理参数。');
      return previous.outcome ?? { success: false, code: 'EXTERNAL_EXECUTION_UNKNOWN', data: { sessionId: previous.sessionId }, error: '上次请求未收到完整结果，未自动重放。' };
    }
    let live: LiveSession;
    let sourceSessionId: string | undefined;
    if (action === 'create' || action === 'fork') {
      const source = action === 'fork' ? await this.owned(String(args.sessionId), context, false) : undefined;
      if (source?.active) throw new Error('请先等待原代理会话结束当前提示，或先停止它。');
      sourceSessionId = source?.record.remoteSessionId;
      if (source && !sourceSessionId) throw new Error('原代理会话尚未完成创建，无法派生。');
      const profiles = this.profiles().filter(profile => profile.enabled);
      const profile = source?.record.profile ?? profiles.find(profile => profile.id === args.profileId) ?? (args.profileId === undefined && profiles.length === 1 ? profiles[0] : undefined);
      if (!profile) throw new Error('请用 list 查看已启用的编码代理，并选择 profileId。');
      const now = Date.now();
      const record: SessionRecord = { id: randomUUID(), profileId: profile.id, profileName: profile.name, profile: structuredClone(profile),
        actorId: context.actorId, conversationId: context.conversationId!, workspace: structuredClone(context.workspace!),
        workspaceId: context.workspace!.id, directory: context.workspace!.directory, status: 'running', createdAt: now, updatedAt: now,
        lastRunId: context.runId, lastEvent: 0, ...(source ? { parentSessionId: source.record.id } : {}) };
      live = { record }; this.sessions.set(record.id, live);
    } else live = await this.owned(String(args.sessionId), context);
    if (live.active) throw new Error('这个代理会话正在执行，请先停止当前任务或等待完成。');
    if (live.record.status === 'closed' && action !== 'load' && action !== 'close') throw new Error('代理会话已关闭，请先用 load 明确恢复会话。');
    const operation: Operation = { id, fingerprint, sessionId: live.record.id, runId: context.runId, status: 'running' };
    const cancel = new AbortController();
    const active: ActiveOperation = { context, cancel, signal: AbortSignal.any([context.signal, cancel.signal]), output: [], images: [],
      replay: action === 'load' || action === 'fork', writes: Promise.resolve(), permissions: Promise.resolve() };
    live.active = active; live.record.status = 'running'; live.record.lastRunId = context.runId; live.record.error = undefined;
    let outcome: ToolOutcome;
    try {
      active.signal.throwIfAborted();
      await this.app.storage.commitRecords([
        { namespace: sessionsNamespace, id: live.record.id, ownerId: live.record.conversationId, value: live.record },
        { namespace: operationsNamespace, id, ownerId: context.conversationId, value: operation },
      ]);
      if (action === 'close') {
        if (live.client?.info.agentCapabilities?.sessionCapabilities?.close && live.record.remoteSessionId)
          await this.request(live, active, 'session/close', { sessionId: live.record.remoteSessionId });
        await this.dispose(live); live.record.status = 'closed';
      } else {
        const client = await this.connect(live, active, sourceSessionId);
        const sessionParams: NewSessionRequest = { cwd: live.record.directory, additionalDirectories: live.record.workspace.roots?.slice(1).map(root => root.directory), mcpServers: [] };
        if (action === 'create') {
          const created = await this.request(live, active, 'session/new', sessionParams);
          live.record.remoteSessionId = created.sessionId; this.configuration(live.record, created);
        } else if (action === 'fork') {
          if (!sourceSessionId || !client.info.agentCapabilities?.sessionCapabilities?.fork) throw new Error('这个代理没有提供会话派生能力。');
          const forked = await this.request(live, active, 'session/fork', { ...sessionParams, sessionId: sourceSessionId });
          live.record.remoteSessionId = forked.sessionId; this.configuration(live.record, forked);
        }
        const sessionId = live.record.remoteSessionId;
        if (!sessionId) throw new Error('代理会话尚未完成创建。');
        active.replay = false;
        if (action === 'configure') {
          if (typeof args.modeId === 'string') {
            await this.request(live, active, 'session/set_mode', { sessionId, modeId: args.modeId });
            if (live.record.modes && typeof live.record.modes === 'object') live.record.modes = { ...live.record.modes, currentModeId: args.modeId };
          }
          else {
            if (typeof args.configId !== 'string' || typeof args.value !== 'string' && typeof args.value !== 'boolean') throw new Error('请提供配置项 ID 和字符串或布尔值。');
            this.configuration(live.record, await this.request(live, active, 'session/set_config_option', {
              sessionId, configId: args.configId, ...(typeof args.value === 'boolean' ? { type: 'boolean', value: args.value } : { value: args.value }),
            }));
          }
        }
        if (action === 'prompt' || action === 'create' && args.prompt !== undefined) {
          const prompt = await this.promptContent(args, context, client);
          this.event(live, 'user_prompt', prompt);
          await active.writes;
          const result = await this.request(live, active, 'session/prompt', { sessionId, prompt });
          this.event(live, 'turn.completed', result);
        }
        live.record.status = 'idle';
      }
      this.flushText(live); await active.writes;
      active.signal.throwIfAborted();
      outcome = { success: true, data: { session: this.summary(live.record), text: active.output.join('') },
        ...(active.images.length ? { attachments: active.images } : {}) };
    } catch (error) {
      this.flushText(live); await active.writes.catch(() => {});
      if (action === 'close' || !live.record.remoteSessionId || live.client?.connection.signal.aborted)
        await this.dispose(live).catch(cause => console.error('外部代理异常后的关闭失败：', cause));
      live.record.status = active.signal.aborted ? 'interrupted' : 'error';
      live.record.error = error instanceof Error ? error.message : String(error);
      operation.status = error instanceof ExecutionUnknown ? 'unknown' : 'completed';
      outcome = { success: false, code: error instanceof ExecutionUnknown ? 'EXTERNAL_EXECUTION_UNKNOWN' : active.signal.aborted ? 'CANCELLED' : 'EXTERNAL_AGENT_FAILED',
        error: live.record.error, data: { session: this.summary(live.record), text: active.output.join('') },
        ...(active.images.length ? { attachments: active.images } : {}) };
    } finally {
      clearTimeout(active.timer);
      active.cancel.abort(new Error('本次代理操作已经结束。'));
      live.active = undefined;
    }
    if (operation.status === 'running') operation.status = 'completed';
    operation.outcome = outcome;
    live.record.updatedAt = Date.now();
    await this.app.storage.commitRecords([
      { namespace: sessionsNamespace, id: live.record.id, ownerId: live.record.conversationId, value: live.record },
      { namespace: operationsNamespace, id, ownerId: context.conversationId, value: operation },
    ]);
    return outcome;
  }
  private configuration(record: SessionRecord, value: { configOptions?: unknown[] | null; modes?: unknown }) {
    if (value.configOptions) record.configOptions = structuredClone(value.configOptions);
    if (value.modes) record.modes = structuredClone(value.modes);
  }
  private async connect(live: LiveSession, active: ActiveOperation, sourceSessionId?: string): Promise<AcpClient> {
    if (live.client && !live.client.connection.signal.aborted) return live.client;
    if (live.client) await this.dispose(live);
    const client = await openAcpClient(live.record.profile, live.record.directory, active.signal, {
      update: value => this.updated(live, value), permission: (value, signal) => this.permission(live, value, signal),
    });
    live.client = client;
    live.record.agentInfo = client.info.agentInfo ?? undefined;
    live.record.capabilities = client.info.agentCapabilities ?? {};
    const remoteSessionId = sourceSessionId ?? live.record.remoteSessionId;
    if (remoteSessionId) {
      const params = { sessionId: remoteSessionId, cwd: live.record.directory, mcpServers: [],
        additionalDirectories: live.record.workspace.roots?.slice(1).map(root => root.directory) };
      active.replay = true;
      if (client.info.agentCapabilities?.sessionCapabilities?.resume)
        this.configuration(live.record, await this.request(live, active, 'session/resume', params));
      else if (client.info.agentCapabilities?.loadSession)
        this.configuration(live.record, await this.request(live, active, 'session/load', params));
      else throw new Error('这个代理没有提供会话恢复能力，原记录仍然保留。');
    }
    return client;
  }
  private async promptContent(args: Record<string, unknown>, context: ToolContext, client: AcpClient): Promise<ContentBlock[]> {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('请提供给编码代理的提示。');
    const content: ContentBlock[] = [{ type: 'text', text: args.prompt }];
    const files = args.images as string[] | undefined;
    if (files?.length && !client.info.agentCapabilities?.promptCapabilities?.image) throw new Error('这个代理未声明图片输入能力。');
    if (files?.length) {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      for (const file of files) {
        const absolute = await this.app.files.resolve(context.workspace!, file);
        const mimeType = types[path.extname(absolute).toLowerCase()];
        if (!mimeType) throw new Error('代理图片输入支持 PNG、JPEG、WebP 和 GIF 文件。');
        content.push({ type: 'image', mimeType, data: (await readFile(absolute)).toString('base64') });
      }
    }
    return content;
  }
  private async request<Method extends AgentRequestMethod>(live: LiveSession, active: ActiveOperation, method: Method,
    params: AgentRequestParamsByMethod[Method]): Promise<AgentRequestResponsesByMethod[Method]> {
    const client = live.client!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      if (method === 'session/prompt') {
        void client.connection.agent.notify('session/cancel', { sessionId: live.record.remoteSessionId! }).catch(() => {});
        timer = setTimeout(() => client.connection.close(new Error('代理取消后没有返回结果。')), 5000); timer.unref();
      } else client.connection.close(active.signal.reason);
    };
    active.signal.throwIfAborted(); active.signal.addEventListener('abort', cancel, { once: true });
    if (method !== 'session/prompt') {
      timer = setTimeout(() => client.connection.close(new Error(`代理请求超时：${method}`)), 30000); timer.unref();
    }
    try { return await client.connection.agent.request<Method>(method, params); }
    catch (error) {
      if (client.connection.signal.aborted) throw new ExecutionUnknown(`${method} 未收到完整结果，未自动重放。${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    finally { clearTimeout(timer); active.signal.removeEventListener('abort', cancel); }
  }
  private permission(live: LiveSession, value: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const active = live.active;
    if (!active || value.sessionId !== live.record.remoteSessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const operation = active.permissions.catch(() => {}).then(async (): Promise<RequestPermissionResponse> => {
      if (active.signal.aborted || signal.aborted) return { outcome: { outcome: 'cancelled' } };
      if (!active.context.requestPermission) throw new Error('当前任务没有权限选择接口。');
      const reason = [value.toolCall.title, value.toolCall.rawInput !== undefined ? JSON.stringify(value.toolCall.rawInput, null, 2) : ''].filter(Boolean).join('\n');
      this.event(live, 'permission.requested', value);
      try {
        const decision = await active.context.requestPermission(reason, value.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind })), AbortSignal.any([signal, active.signal]));
        this.event(live, 'permission.resolved', decision);
        return decision.choiceId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: decision.choiceId } };
      } catch (error) {
        if (active.signal.aborted || signal.aborted) return { outcome: { outcome: 'cancelled' } };
        throw error;
      }
    });
    active.permissions = operation; return operation;
  }
  private updated(live: LiveSession, notification: SessionNotification) {
    const active = live.active, update = notification.update;
    if (!active || active.replay || notification.sessionId !== live.record.remoteSessionId) return;
    if (update.sessionUpdate === 'config_option_update') live.record.configOptions = structuredClone(update.configOptions);
    if (update.sessionUpdate === 'current_mode_update' && live.record.modes && typeof live.record.modes === 'object')
      live.record.modes = { ...live.record.modes, currentModeId: update.currentModeId };
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content.type === 'text') {
        if (update.sessionUpdate === 'agent_message_chunk') active.output.push(update.content.text);
        if (Object.keys(update).every(key => ['sessionUpdate', 'content'].includes(key)) && Object.keys(update.content).every(key => ['type', 'text'].includes(key))) {
          if (active.text?.type !== update.sessionUpdate) this.flushText(live);
          active.text ??= { type: update.sessionUpdate, chunks: [], bytes: 0 };
          active.text.chunks.push(update.content.text); active.text.bytes += Buffer.byteLength(update.content.text);
          if (active.text.bytes >= 16384) this.flushText(live);
          else if (!active.timer) { active.timer = setTimeout(() => this.flushText(live), 200); active.timer.unref(); }
          return;
        }
      } else if (update.content.type === 'image' && update.sessionUpdate === 'agent_message_chunk')
        active.images.push({ mimeType: update.content.mimeType, data: update.content.data });
    }
    this.flushText(live); this.event(live, update.sessionUpdate, update);
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      active.context.progress({ agentSessionId: live.record.id, message: update.title ?? '外部代理正在执行工具', status: update.status });
  }
  private flushText(live: LiveSession) {
    const active = live.active;
    if (!active) return;
    clearTimeout(active.timer); active.timer = undefined;
    if (!active.text) return;
    const text = active.text; active.text = undefined;
    const message = text.chunks.join('');
    this.event(live, text.type, { sessionUpdate: text.type, content: { type: 'text', text: message } });
    if (text.type === 'agent_message_chunk') active.context.progress({ agentSessionId: live.record.id, message });
  }
  private event(live: LiveSession, type: string, data: unknown) {
    const active = live.active;
    if (!active) return;
    const sequence = ++live.record.lastEvent;
    const event: ExternalAgentEvent = { sessionId: live.record.id, sequence, timestamp: Date.now(), runId: active.context.runId, type, data };
    const record = structuredClone(live.record);
    active.writes = active.writes.then(() => this.app.storage.commitRecords([
      { namespace: eventsNamespace, id: `${record.id}:${String(sequence).padStart(12, '0')}`, ownerId: record.conversationId, value: event },
      { namespace: sessionsNamespace, id: record.id, ownerId: record.conversationId, value: record },
    ])).then(() => {});
    void active.writes.catch(error => active.cancel.abort(error));
  }
  private async dispose(live: LiveSession) {
    if (live.disposing) return live.disposing;
    if (!live.client) return;
    const client = live.client;
    live.disposing = client.stop();
    try { await live.disposing; if (live.client === client) live.client = undefined; }
    finally { live.disposing = undefined; }
  }
  private async conversationChanged(id: string) {
    if (await this.app.storage.getConversation(id)) return;
    for (const [key, live] of this.sessions) if (live.record.conversationId === id) {
      live.active?.cancel.abort(new Error('原任务已经删除。'));
      await this.dispose(live); this.sessions.delete(key);
    }
    this.refreshTools();
  }
  async close() {
    this.closing = true; this.unsubscribe();
    for (const live of this.sessions.values()) live.active?.cancel.abort(new Error('应用正在关闭。'));
    const results = await Promise.allSettled([...this.sessions.values()].map(live => this.dispose(live)));
    await Promise.allSettled([...this.operations.values()].map(operation => operation.promise));
    for (const result of results) if (result.status === 'rejected') console.error('外部代理关闭失败：', result.reason);
  }
}
