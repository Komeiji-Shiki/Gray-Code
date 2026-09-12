import type { BotStatus, RunEvent, PlatformMessage } from '@graycode/contracts';
export type { BotStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { saveBotDocument } from './documents';
import { cleanBotPresentationReferences } from './presentation';
import type { BotGateway, BotInbound, BotInteraction } from './gateway';
import { discordNeedsMessageContent, discordTriggered } from './config';
import { BotSessions, parseBotAction, botRunLabels, type BotContext, type BotPlatform, type BotRoute } from './sessions';
import { BotOutbox } from './outbox';
import { BotStreams, botFinalReplies, botMessageText } from './streaming';
import { botRunMessages, botRunReply } from './rounds';
import { botInboundParts } from './media';
import { BotSummaries } from './summaries';

/** 平台适配器负责传输，共享会话服务负责所有文字指令和交互菜单的任务操作。 */
export class BoundBotService {
  private gateway?: BotGateway;
  private connectionEpoch = 0;
  private current: BotStatus = { status: 'stopped' };
  private connectedMessageContent?: boolean;
  private readonly unsubscribe: () => void;
  private starting?: Promise<BotStatus>;
  private automatic = false;
  private retryEpoch = 0;
  private retryDelay = 5_000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private events: Promise<unknown> = Promise.resolve();
  private readonly inbound = new Map<string, Promise<unknown>>();
  readonly sessions: BotSessions;
  readonly outbox: BotOutbox;
  readonly summaries: BotSummaries;
  private readonly streams: BotStreams;
  constructor(protected readonly app: PlatformApplication, protected readonly platform: BotPlatform, private readonly factory: () => BotGateway) {
    this.sessions = new BotSessions(app);
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
    return { ...this.current, ...this.outbox.status(), needsReconnect };
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
  protected context(source: Pick<BotInbound, 'id' | 'authorId' | 'channelId' | 'direct' | 'network' | 'authorName'>): BotContext {
    if (this.current.status !== 'connected' || !this.current.botId) throw new Error('Bot 尚未连接。');
    return { id: source.id, authorId: source.authorId, channelId: source.channelId, direct: source.direct,
      network: source.network, authorName: source.authorName, platform: this.platform, botId: this.current.botId };
  }
  protected async interaction(input: BotInteraction): Promise<void> { await input.respond({ content: '当前接入没有操作面板。' }); }
  protected clearInteractions(): void {}
  start(): Promise<BotStatus> { this.cancelAutoRetry(); return this.startAttempt(); }
  private startAttempt(): Promise<BotStatus> { return this.starting ??= this.connect().finally(() => { this.starting = undefined; this.notifyConnectionChange(); }); }
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
        status => { if (this.gateway !== gateway || epoch !== this.connectionEpoch) return; this.current.status = status; this.notifyConnectionChange(); if (status === 'connected') void this.outbox.flush(); });
      if (this.gateway !== gateway || epoch !== this.connectionEpoch) { await gateway.disconnect(); return this.status(); }
      this.connectedMessageContent = allMessages;
      this.current = { status: 'connected', botId: user.id, name: user.name, avatarUrl: user.avatarUrl, controlsReady: user.controlsReady, warning: user.warning };
      await this.streams.resume(); await this.outbox.flush(); await this.sessions.inbox.resume(this.platform); this.summaries.start(); return this.status();
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
    let context: BotContext;
    try { context = this.context(message); } catch { return; }
    if (!this.sessions.canRecord(context)) return;
    const key = this.sessions.key(context);
    const work = (this.inbound.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.receiveOne(context, message));
    this.inbound.set(key, work);
    try { await work; } finally { if (this.inbound.get(key) === work) this.inbound.delete(key); }
  }
  private async receiveOne(context: BotContext, message: BotInbound): Promise<void> {
    let actorId: string | undefined;
    try { actorId = this.sessions.authorize(context).id; } catch { /* 未绑定成员仍提供获准频道的背景上下文。 */ }
    const config = this.app.settings.snapshot().settings[this.platform]!;
    const text = (this.platform === 'discord' ? message.content.replace(new RegExp(`<@!?${context.botId}>`, 'g'), '') : message.content).trim();
    const triggered = !!actorId && !message.automated && (this.platform === 'discord' ? discordTriggered(this.app.settings.snapshot().settings.discord, message, text)
      : !config.mentionOnly || message.mentioned || message.direct);
    try {
      const resolved = await this.gateway?.hydrate?.(message) ?? message;
      const hydrated = this.platform === 'discord' ? await cleanBotPresentationReferences(this.app, resolved, context.botId) : resolved;
      let documentConversation: Promise<string> | undefined;
      const parts = await botInboundParts({ ...hydrated, content: text }, this.platform, undefined, async (attachment, bytes) => {
        const id = await (documentConversation ??= this.sessions.serial(context, async () => (await this.sessions.recordingConversation(context)).conversation.id));
        return saveBotDocument(this.app, id, attachment, bytes);
      });
      const action = parseBotAction(text);
      const control = triggered && action.kind !== 'message';
      await this.sessions.inbox.receive(context, hydrated, parts, triggered && !control, !message.mentioned && !triggered);
      if (!control || !actorId) return;
      const result = await this.sessions.perform(context, action);
      if (result.reply) {
        const snapshot = await this.sessions.snapshot(context);
        const route: BotRoute = { platform: this.platform, botId: context.botId, channelId: context.channelId, actorId,
          conversationId: snapshot.conversation?.id ?? '', platformUserId: context.authorId, direct: context.direct, network: context.network,
          ...(this.platform === 'discord' ? { replyToMessageId: message.id } : {}) };
        await this.outbox.put(`reply-${message.id}`, route, botFinalReplies(result.reply, route));
      }
    } catch (error) {
      this.current.error = error instanceof Error ? error.message : 'Bot 请求未完成。';
      if (!actorId || !triggered) return;
      const route: BotRoute = { platform: this.platform, botId: context.botId, channelId: context.channelId, actorId,
        conversationId: '', platformUserId: context.authorId, direct: context.direct, network: context.network,
        ...(this.platform === 'discord' ? { replyToMessageId: message.id } : {}) };
      await this.outbox.put(`error-${message.id}`, route, [{ content: `这条消息尚未完成处理：${this.current.error}` }]).catch(() => {});
    }
  }
  private async onEvent(event: RunEvent): Promise<void> {
    if (!['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted', 'approval.requested', 'question.asked'].includes(event.type)) return;
    const run = await this.app.storage.getRun(event.runId); if (!run) return;
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
    if (event.type === 'run.completed') {
      const messages = await botRunMessages(this.app, run);
      const conclusion = event.payload.reason === 'document_confirmation' ? '文档已经生成，正在等待确认。请在桌面端审阅并确认设计、评审或计划后继续。' : undefined;
      if (this.platform === 'discord') ({ text, footer } = botRunReply(messages, route, conclusion));
      else text = conclusion ?? botMessageText(messages.at(-1), route, this.platform);
    } else if (event.type === 'question.asked') {
      const request = this.app.runtime.pendingQuestions().find(item => item.id === event.payload.id); if (!request) return;
      text = request.questions.map((question, index) => `${index + 1}. ${question.title}`).join('\n')
        + `\n\n${this.platform === 'discord' ? '使用 /gray 面板回答，或输入：\n' : ''}/gray answer ${request.id} 你的回答\n多个回答用 | 分隔。`;
    } else if (event.type === 'approval.requested') {
      text = `有操作等待主人确认：${event.payload.toolName}\n${this.platform === 'discord' ? '使用 /gray 面板查看详情并确认。' : `/gray approve ${event.payload.id}\n/gray deny ${event.payload.id}`}`;
    } else {
      text = `任务${botRunLabels[run.status]}${run.error ? '，失败详情可在桌面端查看。' : '。'}`;
      if (this.platform === 'discord') ({ text, footer } = botRunReply(await botRunMessages(this.app, run), route, text));
    }
    const terminal = event.type.startsWith('run.');
    if (terminal && await this.streams.finish(run.id, route, text, footer)) return;
    await this.outbox.put(`${event.runId}-${event.sequence}`, route, botFinalReplies(text, route, footer));
  }
  async guilds() { if (!this.gateway?.listGuilds) throw new Error('请先连接 Discord。'); return this.gateway.listGuilds(); }
  async channels(guildId: string) { if (!this.gateway?.listChannels) throw new Error('请先连接 Discord。'); return this.gateway.listChannels(guildId); }
  async user(userId: string) { if (!this.gateway?.getUser) throw new Error('请先连接 Discord。'); return this.gateway.getUser(userId); }
  async close(): Promise<void> {
    this.unsubscribe(); this.cancelAutoRetry(); await Promise.allSettled(this.inbound.values()); await this.events;
    await this.sessions.close(); await this.streams.close(); await this.stop(); await this.outbox.close();
  }
}
