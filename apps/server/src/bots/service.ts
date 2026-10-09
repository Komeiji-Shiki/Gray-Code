import type { BotStatus, RunEvent, PlatformMessage, BotPermissionDiagnostic } from '@graycode/contracts';
export type { BotStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { saveBotDocument } from './documents';
import { cleanBotPresentationReferences } from './presentation';
import type { BotGateway, BotInbound, BotInteraction, BotReply } from './gateway';
import { discordNeedsMessageContent, discordTriggered, discordTrigger } from './config';
import { BotSessions, parseBotAction, botRunLabels, type BotContext, type BotPlatform, type BotRoute } from './sessions';
import { BotOutbox } from './outbox';
import { BotStreams, botFinalReplies, botMessageText, botGeneratedImages } from './streaming';
import { botRunMessages, botRunReply } from './rounds';
import { botInboundParts } from './media';
import { BotSummaries } from './summaries';
import { publicBotError } from './errorSummary';
import { BotDiagnostics } from './diagnostics';

/** 平台适配器负责传输，共享会话服务负责所有文字指令和交互菜单的任务操作。 */
export class BoundBotService {
  private gateway?: BotGateway;
  private connectionEpoch = 0;
  private current: BotStatus = { status: 'stopped' };
  private connectedMessageContent?: boolean;
  private readonly unsubscribe: () => void;
  private starting?: Promise<BotStatus>;
  private startingEpoch?: number;
  private automatic = false;
  private retryEpoch = 0;
  private retryDelay = 5_000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private events: Promise<unknown> = Promise.resolve();
  private readonly inbound = new Map<string, Promise<unknown>>();
  private readonly receiving = new Map<string, Promise<void>>();
  readonly diagnostics = new BotDiagnostics();
  readonly sessions: BotSessions;
  readonly outbox: BotOutbox;
  readonly summaries: BotSummaries;
  private readonly streams: BotStreams;
  constructor(protected readonly app: PlatformApplication, protected readonly platform: BotPlatform, private readonly factory: () => BotGateway) {
    this.sessions = new BotSessions(app);
    this.sessions.inbox.observe = (context, stage, reason, conversationId, runId) => this.diagnostics.update(context.id, stage, reason, conversationId, runId);
    this.summaries = new BotSummaries(app, platform, this.sessions);
    this.outbox = new BotOutbox(app, platform, () => this.gateway && this.current.status === 'connected' && this.current.botId
      ? { gateway: this.gateway, botId: this.current.botId } : undefined, route => this.admitted(route));
    this.streams = new BotStreams(app, platform, this.sessions, this.outbox);
    this.unsubscribe = app.subscribe(notification => {
      if (notification.type === 'settings.changed') {
        if (!this.app.settings.snapshot().settings[this.platform]?.enabled) { void this.stop(); return; }
        if (!this.autoConnectEnabled()) { this.cancelAutoRetry(); this.notifyConnectionChange(); }
      }
      if (notification.type === 'model.delta') { this.streams.delta(String(notification.runId), notification.parts as Record<string, unknown>[]); return; }
      if (notification.type === 'message.persisted') { this.streams.saved(String(notification.runId), notification.content as PlatformMessage); return; }
      if (notification.type !== 'event') return;
      const event = notification.event as RunEvent;
      if (event.type === 'model.started') this.streams.started(event.runId);
      if (event.type === 'tool.started') this.streams.status(event.runId, `正在调用 ${event.payload.toolName}`);
      if (event.type === 'approval.requested') this.streams.status(event.runId, '等待主人确认操作');
      this.events = this.events.then(() => this.onEvent(event)).catch(() => { this.current.error = '任务通知准备失败，完整记录仍可在桌面查看。'; });
    });
  }
  /** 已连接或正在连接的 Bot 是常驻服务，空闲等待消息时也需要核心继续运行。 */
  get keepsAlive(): boolean { return !!this.gateway || !!this.starting || this.automatic; }
  private notifyConnectionChange() {
    this.app.publish({ type: 'bot.connection.changed', platform: this.platform });
    this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'bot.connection.changed',
      data: { platform: this.platform, status: this.status() } } });
  }
  status(): BotStatus {
    const needsReconnect = this.platform === 'discord' && this.current.status === 'connected'
      && this.connectedMessageContent !== discordNeedsMessageContent(this.app.settings.snapshot().settings.discord);
    return { ...this.current, ...this.gateway?.health?.(), ...this.outbox.status(), needsReconnect };
  }
  async autoConnect(): Promise<void> {
    if (this.automatic || !this.autoConnectEnabled()) return;
    this.cancelAutoRetry(); this.automatic = true;
    await this.automaticAttempt(this.retryEpoch);
  }
  private autoConnectEnabled(): boolean {
    const settings = this.app.settings.snapshot().settings[this.platform];
    return !!settings?.enabled && settings.autoConnect !== false;
  }
  private cancelAutoRetry() {
    this.automatic = false; this.retryEpoch++; this.retryDelay = 5_000;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined; delete this.current.retryAt;
  }
  private async automaticAttempt(epoch: number): Promise<void> {
    if (epoch !== this.retryEpoch || !this.autoConnectEnabled()) return;
    try { await this.startAttempt(); this.retryDelay = 5_000; }
    catch {
      if (epoch !== this.retryEpoch || !this.autoConnectEnabled()) return;
      // 只重试启动连接；已连接后的短线重连由各平台网关负责。
      const delay = this.retryDelay; this.retryDelay = Math.min(60_000, delay * 2);
      this.current.retryAt = Date.now() + delay;
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; delete this.current.retryAt; void this.automaticAttempt(epoch); }, delay);
      this.retryTimer.unref(); this.notifyConnectionChange();
    }
  }
  protected context(source: Pick<BotInbound, 'id' | 'authorId' | 'channelId' | 'direct' | 'network' | 'authorName' | 'sourceMessageId'>): BotContext {
    if (this.current.status !== 'connected' || !this.current.botId) throw new Error('Bot 尚未连接。');
    return { id: source.id, sourceMessageId: source.sourceMessageId ?? (this.platform === 'discord' ? source.id : undefined),
      authorId: source.authorId, channelId: source.channelId, direct: source.direct,
      network: source.network, authorName: source.authorName, platform: this.platform, botId: this.current.botId };
  }
  protected async interaction(input: BotInteraction): Promise<void> { await input.respond({ content: '当前接入没有操作面板。' }); }
  protected clearInteractions(): void {}
  start(): Promise<BotStatus> { this.cancelAutoRetry(); return this.startAttempt(); }
  private startAttempt(): Promise<BotStatus> {
    if (this.starting && this.startingEpoch === this.connectionEpoch) return this.starting;
    // 停止后立即重连应启动新轮次；旧凭据或网关迟到时，只释放它自己持有的启动状态。
    const operation = this.connect().finally(() => {
      if (this.starting === operation) { this.starting = undefined; this.startingEpoch = undefined; }
      this.notifyConnectionChange();
    });
    this.starting = operation; this.startingEpoch = this.connectionEpoch;
    return operation;
  }
  private async connect(): Promise<BotStatus> {
    const epoch = this.connectionEpoch + 1;
    await this.disconnect();
    if (epoch !== this.connectionEpoch) return this.status();
    let gateway: BotGateway | undefined;
    try {
      const settings = this.app.settings.snapshot().settings[this.platform];
      if (!settings?.enabled || this.platform === 'discord' && !settings.credentialRef) throw new Error('请先保存已启用的 Bot 配置和凭据。');
      const token = settings.credentialRef ? await this.app.settings.credential(settings.credentialRef) : '';
      if (epoch !== this.connectionEpoch) return this.status();
      if (settings.credentialRef && !token) throw new Error('Bot 凭据不可用，请重新填写。');
      this.current = { status: 'connecting' }; this.notifyConnectionChange();
      gateway = this.gateway = this.factory();
      gateway.setInteractionHandler?.(input => this.gateway === gateway && epoch === this.connectionEpoch
        ? this.interaction(input) : input.respond({ content: '连接已经变化，请重新打开 /gray 面板。' }));
      const allMessages = this.platform === 'discord' ? discordNeedsMessageContent(this.app.settings.snapshot().settings.discord) : !settings.mentionOnly;
      const user = await gateway.connect(token ?? '', allMessages, message => { if (this.gateway === gateway && epoch === this.connectionEpoch) void this.receive(message); },
        status => {
          if (this.gateway !== gateway || epoch !== this.connectionEpoch || this.current.status === status) return;
          this.current.status = status; this.notifyConnectionChange();
          if (status === 'connected') { void this.outbox.flush(); if (this.current.botId) void this.sessions.inbox.resume(this.platform); }
          else this.sessions.inbox.pause();
        });
      if (this.gateway !== gateway || epoch !== this.connectionEpoch) { await gateway.disconnect(); return this.status(); }
      this.connectedMessageContent = allMessages;
      this.current = { status: gateway.health?.().online === false ? 'offline' : 'connected', botId: user.id, name: user.name, avatarUrl: user.avatarUrl, controlsReady: user.controlsReady, warning: user.warning };
      await this.streams.resume();
      if (epoch !== this.connectionEpoch) return this.status();
      await this.outbox.flush();
      if (epoch !== this.connectionEpoch) return this.status();
      if (this.current.status === 'connected') await this.sessions.inbox.resume(this.platform);
      if (epoch !== this.connectionEpoch) return this.status();
      this.summaries.start(); return this.status();
    } catch (error) {
      if (epoch !== this.connectionEpoch) return this.status();
      this.gateway = undefined;
      await Promise.allSettled([this.summaries.stop(), this.streams.pause(), gateway?.disconnect()]);
      if (epoch !== this.connectionEpoch) return this.status();
      this.current = { status: 'failed', error: error instanceof Error ? error.message : 'Bot 连接失败。' }; throw error;
    }
  }
  async stop(): Promise<void> {
    this.cancelAutoRetry(); await this.disconnect();
  }
  private async disconnect(): Promise<void> {
    const epoch = ++this.connectionEpoch; const gateway = this.gateway; this.gateway = undefined;
    this.sessions.inbox.pause();
    this.clearInteractions(); await this.summaries.stop(); await this.streams.pause(); await gateway?.disconnect();
    if (epoch === this.connectionEpoch) { this.current = { status: 'stopped' }; this.notifyConnectionChange(); }
  }
  private async admitted(route: BotRoute): Promise<boolean> {
    route.platform ??= this.platform;
    if (route.direct === undefined) {
      if (this.platform === 'onebot') route.direct = route.channelId.startsWith('private:');
      else if (this.gateway?.getChannel) {
        try { route.direct = (await this.gateway.getChannel(route.channelId)).direct; } catch { return false; }
      }
    }
    return this.sessions.admitted(route);
  }
  async receive(message: BotInbound): Promise<void> {
    this.diagnostics.receive(message);
    let context: BotContext;
    try { context = this.context(message); } catch { this.diagnostics.update(message.id, 'ignored', 'Bot 尚未连接。'); return; }
    if (!this.sessions.canRecord(context)) { this.diagnostics.update(message.id, 'ignored', '会话未获准、用户被拉黑，或私聊权限不足。'); return; }
    if (this.receiving.has(message.id)) { this.diagnostics.update(message.id, 'duplicate', '同一条消息正在处理，无需重复解析附件。'); return; }
    const text = (this.platform === 'discord' ? message.content.replace(new RegExp(`<@!?${context.botId}>`, 'g'), '') : message.content).trim();
    const receivedAt = Date.now();
    const key = this.sessions.key(context);
    const process = async () => {
      if (await this.sessions.inbox.contains(context)) { this.diagnostics.update(message.id, 'duplicate', '这条平台消息已经处理。'); return; }
      await this.receiveOne(context, message, text, receivedAt);
    };
    // 控制指令仍走会话事务和实时授权，但不等待前一条消息的网络附件读取。
    const priority = ['status', 'cancel', 'answer', 'approval', 'interrupt', 'help', 'source', 'workspaces'].includes(parseBotAction(text).kind);
    const work = (priority ? process() : (this.inbound.get(key) ?? Promise.resolve()).catch(() => {}).then(process))
      .catch(error => { this.current.error = (error as Error).message; this.diagnostics.update(message.id, 'failed', this.current.error); });
    this.receiving.set(message.id, work);
    if (!priority) this.inbound.set(key, work);
    try { await work; } finally { this.receiving.delete(message.id); if (this.inbound.get(key) === work) this.inbound.delete(key); }
  }
  private async receiveOne(context: BotContext, message: BotInbound, text: string, receivedAt: number): Promise<void> {
    let actorId: string | undefined;
    let denied: string | undefined;
    try { actorId = this.sessions.authorize(context).id; } catch (error) { denied = (error as Error).message; }
    const settings = this.app.settings.read('discord', 'onebot');
    const config = settings[this.platform]!;
    const action = parseBotAction(text);
    const control = action.kind !== 'message';
    let triggered = !!actorId && !message.automated && discordTriggered(config, message, text);
    try {
      this.diagnostics.update(message.id, control ? 'control' : 'preparing', control ? '正在处理控制指令。' : '正在读取引用和附件。');
      const resolved = control ? { ...message, attachments: [], references: [], segments: undefined } : await this.gateway?.hydrate?.(message) ?? message;
      const hydrated = this.platform === 'discord' ? await cleanBotPresentationReferences(this.app, resolved, context.botId) : resolved;
      triggered = !!actorId && !message.automated && discordTriggered(config, hydrated, text);
      let documentConversation: Promise<string> | undefined;
      const parts = await botInboundParts({ ...hydrated, content: text }, this.platform, undefined, async (attachment, bytes) => {
        const id = await (documentConversation ??= this.sessions.serial(context, async () => (await this.sessions.recordingConversation(context)).conversation.id));
        return saveBotDocument(this.app, id, attachment, bytes);
      });
      const result = control && triggered && actorId ? await this.sessions.perform(context, action) : undefined;
      await this.sessions.inbox.receive(context, hydrated, parts, triggered && !control, !message.mentioned && !triggered, receivedAt, control);
      if (denied || message.automated) this.diagnostics.update(message.id, 'ignored', denied ?? '机器人和 Webhook 消息只作为背景。');
      if (!result || !actorId) return;
      this.diagnostics.update(message.id, 'control', '控制指令已处理。');
      if (result.reply) {
        const snapshot = await this.sessions.snapshot(context);
        const route: BotRoute = { platform: this.platform, botId: context.botId, channelId: context.channelId, actorId,
          conversationId: snapshot.conversation?.id ?? '', platformUserId: context.authorId, direct: context.direct, network: context.network,
          ...(context.sourceMessageId ? { replyToMessageId: context.sourceMessageId } : {}) };
        await this.outbox.put(`reply-${message.id}`, route, botFinalReplies(result.reply, route));
      }
    } catch (error) {
      this.current.error = error instanceof Error ? error.message : 'Bot 请求未完成。';
      this.diagnostics.update(message.id, 'failed', this.current.error);
      if (!actorId || !triggered) return;
      const route: BotRoute = { platform: this.platform, botId: context.botId, channelId: context.channelId, actorId,
        conversationId: '', platformUserId: context.authorId, direct: context.direct, network: context.network,
        ...(context.sourceMessageId ? { replyToMessageId: context.sourceMessageId } : {}) };
      const visible = publicBotError(this.current.error);
      await this.outbox.put(`error-${message.id}`, route, [{ content: visible
        ? `这条消息尚未完成处理：${visible}` : '这条消息尚未完成处理，详情可在桌面端查看。' }]).catch(() => {});
    }
  }
  private async onEvent(event: RunEvent): Promise<void> {
    if (!['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted', 'approval.requested', 'question.asked'].includes(event.type)) return;
    const run = await this.app.storage.getRun(event.runId); if (!run) return;
    if (event.type.startsWith('run.') && run.requestKey.startsWith(`${this.platform}:`)) this.diagnostics.update(run.requestKey.slice(this.platform.length + 1), event.type === 'run.completed' ? 'completed' : 'failed',
      event.type === 'run.completed' ? '回复已生成；投递状态可在待发送列表查看。' : `任务${botRunLabels[run.status]}`, run.conversationId, run.id);
    if (event.type.startsWith('run.') && this.current.status === 'connected') void this.sessions.inbox.flush(run.conversationId).catch(error => { this.current.error = (error as Error).message; });
    const route = await this.sessions.routeForRun(this.platform, run);
    if (!route) return;
    if (!await this.admitted(route)) {
      if (event.type.startsWith('run.')) await this.streams.discard(run.id);
      return;
    }
    if (event.type.startsWith('run.') && route.conversationId !== run.conversationId) return;
    let text: string;
    let footer: string | undefined;
    let attachments: BotReply[] = [];
    if (event.type === 'run.completed') {
      const messages = await botRunMessages(this.app, run);
      attachments = botGeneratedImages(messages);
      const conclusion = event.payload.reason === 'document_confirmation' ? '文档已经生成，正在等待确认。请在桌面端审阅并确认设计、评审或计划后继续。' : undefined;
      if (this.platform === 'discord') ({ text, footer } = botRunReply(messages, route, conclusion));
      else text = conclusion ?? botMessageText(messages.at(-1), route, this.platform);
    } else if (event.type === 'question.asked') {
      const request = this.app.runtime.pendingQuestions().find(item => item.id === event.payload.id); if (!request) return;
      text = request.questions.map((question, index) => `${index + 1}. ${question.title}`).join('\n')
        + `\n\n${this.platform === 'discord' ? '使用 /gray 面板回答，或输入：\n' : ''}/gray answer ${request.id} 你的回答\n多个回答用 | 分隔。`;
    } else if (event.type === 'approval.requested') {
      text = `有操作等待主人确认：${event.payload.toolName}\n${this.platform === 'discord' ? '使用 /gray 面板查看详情并确认。' : `/gray approve ${event.payload.id}\n/gray deny ${event.payload.id}`}`;
      if (Array.isArray(event.payload.choices)) text = `有操作等待主人选择：${event.payload.toolName}\n${event.payload.reason ?? ''}\n`
        + (event.payload.choices as import('@graycode/contracts').ApprovalChoice[]).map((choice, index) => `${index + 1}. ${choice.label}`).join('\n')
        + `\n/gray choose ${event.payload.id} 选项序号`;
    } else {
      const visible = event.type === 'run.failed' && this.platform === 'discord' ? publicBotError(run.error) : undefined;
      text = `任务${botRunLabels[run.status]}${visible ? `：${visible}` : run.error ? '，失败详情可在桌面端查看。' : '。'}`;
      if (this.platform === 'discord' && (event.type === 'run.failed' || event.type === 'run.interrupted')) text += '\n可用 /gray-retry 重试。';
      if (this.platform === 'discord') ({ text, footer } = botRunReply(await botRunMessages(this.app, run), route, text));
    }
    const terminal = event.type.startsWith('run.');
    if (terminal && await this.streams.finish(run.id, route, text, footer, attachments)) return;
    await this.outbox.put(`${event.runId}-${event.sequence}`, route, [...botFinalReplies(text, route, footer), ...attachments]);
  }
  async guilds() { if (!this.gateway?.listGuilds) throw new Error('请先连接 Discord。'); return this.gateway.listGuilds(); }
  async channels(guildId: string) { if (!this.gateway?.listChannels) throw new Error('请先连接 Discord。'); return this.gateway.listChannels(guildId); }
  async user(userId: string) { if (!this.gateway?.getUser) throw new Error('请先连接 Discord。'); return this.gateway.getUser(userId); }
  checkPermission(authorId: string, channelId: string, direct: boolean): BotPermissionDiagnostic {
    const config = this.app.settings.read(this.platform)[this.platform]!;
    const context: BotContext = { id: 'permission-check', platform: this.platform, botId: this.current.botId ?? '', authorId, channelId, direct,
      network: this.platform === 'onebot' ? this.app.settings.read('onebot').onebot?.protocolVersion === 12 ? this.app.settings.read('onebot').onebot?.self?.platform : 'qq' : undefined };
    const trigger = discordTrigger(config, channelId);
    try { const actor = this.sessions.authorize(context); return { allowed: true, reason: '可以在此会话发起任务，工具仍按该账号的授权执行。', actorName: actor.displayName, trigger }; }
    catch (error) { return { allowed: false, reason: (error as Error).message, trigger }; }
  }
  async close(): Promise<void> {
    this.unsubscribe(); this.cancelAutoRetry(); this.sessions.inbox.pause(); await Promise.allSettled(this.receiving.values()); await this.events;
    await this.sessions.close(); await this.streams.close(); await this.stop(); await this.outbox.close();
  }
}
