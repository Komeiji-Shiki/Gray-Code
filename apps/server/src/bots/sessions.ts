import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ActorIdentity, ApprovalRequest, DiscordOutputSettings, DiscordReplyProfile, PlatformConversation, RecordMutation, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotInbound } from './gateway';
import { discordAdmitted, discordOutput, botProfile } from './config';
import { captureBotAgent } from './profiles';
import { BOT_CHANNEL_ACCESS, addBotParticipant, sameBotChannel, type BotChannelAccess } from './channelAccess';
import { BotInbox, type BotInboxItem } from './inbox';
import { captureBotEnvironment } from './prompt';
import { actorForBotRun, isBotUserBlocked, resolveBotUser } from './permissions';
import { authorizeEffects } from '@graycode/core';
import { distributionSourceNotice } from '../../../../shared/distribution';

export type BotPlatform = 'discord' | 'onebot';
export interface BotRoute {
  platform?: BotPlatform; botId: string; channelId: string; actorId: string; conversationId: string;
  platformUserId?: string; network?: string; direct?: boolean;
  replyToMessageId?: string;
  output?: DiscordOutputSettings;
}
export interface BotContext extends Pick<BotInbound, 'id' | 'authorId' | 'channelId' | 'direct' | 'network' | 'authorName' | 'sourceMessageId'> {
  botId: string; platform: BotPlatform;
}
export interface BotSession {
  version: 2 | 3; context: Omit<BotContext, 'id' | 'authorName' | 'sourceMessageId'>; actorId: string;
  conversationId?: string; selection: DiscordReplyProfile; updatedAt: number;
}
export type BotAction =
  | { kind: 'status' | 'help' | 'source' | 'new' | 'cancel' | 'retry' | 'workspaces' }
  | { kind: 'workspace'; workspaceId: string | null }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'model-default' }
  | { kind: 'message' | 'interrupt'; text: string; input?: BotInboxItem }
  | { kind: 'answer'; questionId: string; answers: string[] }
  | { kind: 'approval'; approvalId: string; accepted: boolean; choiceId?: string; choiceIndex?: number };
interface LoadedSession { id: string; revision: number | null; value: BotSession; actor: ActorIdentity; profile: DiscordReplyProfile }
export const botKey = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const namespace = 'bot-sessions';
const receipts = 'bot-receipts';
export const botRouteNamespace = 'bot-request-routes';
const active = (run?: RunRecord) => !!run && ['queued', 'running', 'awaiting_input', 'awaiting_approval'].includes(run.status);
export const botRunLabels: Record<RunRecord['status'], string> = { queued: '排队中', running: '执行中', awaiting_input: '等待回答', awaiting_approval: '等待确认',
  completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };

/** 对话选择与模型配置分别保存；同一个任务的回复位置在启动事务中固定。 */
export class BotSessions {
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly inbox: BotInbox;
  constructor(private readonly app: PlatformApplication) { this.inbox = new BotInbox(app, this); }
  owner(): ActorIdentity {
    const actor = this.app.settings.snapshot().settings.accounts.find(item => item.role === 'owner' && !item.revoked);
    if (!actor) throw new Error('当前部署没有可用的主人账号。');
    return actor;
  }
  canRecord(context: BotContext): boolean {
    if (isBotUserBlocked(this.app.settings.snapshot().settings, { platform: context.platform, platformUserId: context.authorId, network: context.network })) return false;
    const config = this.app.settings.snapshot().settings[context.platform];
    if (!config?.enabled) return false;
    if (!context.direct) return config.allowedChannelIds.includes(context.channelId);
    try { this.authorize(context); return true; } catch { return false; }
  }
  authorize(context: BotContext): ActorIdentity {
    const settings = this.app.settings.snapshot().settings;
    const source = { platform: context.platform, platformUserId: context.authorId, network: context.network };
    const actor = resolveBotUser(settings, source);
    if (!actor) throw new Error(isBotUserBlocked(settings, source) ? '这个用户已被拉黑或授权已撤销。' : `账号尚未绑定，默认访客对话也未启用。你的数字用户 ID 是 ${context.authorId}，请由主人配置默认权限或单独授权。`);
    if (context.platform === 'discord') {
      if (context.direct && actor.role !== 'owner') throw new Error('Discord 私聊当前只对主人开放。');
      if (!discordAdmitted(settings.discord, context, actor)) throw new Error(context.direct ? '主人已关闭 Bot 私聊。' : '这个频道尚未启用，请在桌面管理页选择允许响应的频道。');
    } else if (!settings.onebot?.enabled || !settings.onebot.allowedChannelIds.includes(context.channelId)) throw new Error('这个 OneBot 会话尚未启用。');
    return actor;
  }
  async admitted(route: BotRoute): Promise<boolean> {
    if (route.direct === undefined) return false;
    const platform = route.platform ?? 'discord';
    const settings = this.app.settings.snapshot().settings;
    const actor = this.app.actor(route.actorId);
    const candidates = settings.bindings.filter(binding => binding.platform === platform && binding.accountId === route.actorId
      && (platform !== 'onebot' || (binding.network ?? 'qq') === (route.network ?? 'qq')));
    const userId = route.platformUserId ?? (candidates.length === 1 ? candidates[0].platformUserId : undefined);
    const current = userId && resolveBotUser(settings, { platform, platformUserId: userId, network: route.network });
    if (!actor || !current || current.id !== actor.id) return false;
    return platform === 'discord' ? discordAdmitted(settings.discord, { direct: route.direct, channelId: route.channelId }, actor)
      : !!settings.onebot?.enabled && settings.onebot.allowedChannelIds.includes(route.channelId);
  }
  key(context: BotContext) { return botKey('channel-v3', context.platform, context.botId, context.channelId, context.direct ? 'direct' : 'group', context.network ?? ''); }
  async load(context: BotContext, recording = false): Promise<LoadedSession> {
    let actor: ActorIdentity;
    try { actor = this.authorize(context); } catch (error) { if (!recording || !this.canRecord(context)) throw error; actor = this.owner(); }
    const id = this.key(context);
    const record = await this.app.storage.getVersionedRecord(namespace, id);
    let value = record.value as BotSession | null;
    const settings = this.app.settings.snapshot().settings;
    const config = settings[context.platform]!;
    if (!value) {
      const owner = this.owner();
      const previous = await this.app.storage.getRecord(namespace, botKey(context.platform, context.botId, context.channelId, owner.id, context.network ?? '')) as BotSession | null;
      // 原版本按智能体建立路由；首次读取只承接当前配置的原路由，旧记录仍保留。
      const oldKey = botKey(context.botId, context.channelId, actor.id, config.agentId, context.network ?? '');
      const target = await this.app.storage.getRecord(`${context.platform}-targets`, oldKey) as { workspaceId: string | null } | null;
      const route = await this.app.storage.getRecord(`${context.platform}-channels`, oldKey) as BotRoute | null
        ?? await this.app.storage.getRecord(`${context.platform}-channels`, botKey(context.botId, context.channelId, actor.id, config.agentId, config.workspaceId ?? '')) as BotRoute | null;
      value = { version: 3, context: { platform: context.platform, botId: context.botId, channelId: context.channelId, authorId: context.authorId, direct: context.direct, network: context.network },
        actorId: owner.id, conversationId: previous?.conversationId ?? route?.conversationId, selection: previous?.selection ?? (target ? { workspaceId: target.workspaceId } : {}), updatedAt: previous?.updatedAt ?? Date.now() };
      if (value.conversationId) {
        const old = await this.app.storage.getConversation(value.conversationId);
        const origin = (old?.custom as Record<string, unknown> | undefined)?.botOrigin as { platform?: string; channelId?: string } | undefined;
        // 只自动沿用本频道的 Bot 历史，不把主人手动选择的私人对话公开给群成员。
        if (!old || origin?.platform !== context.platform || origin.channelId !== context.channelId) delete value.conversationId;
        else if (!await this.app.storage.getRecord(BOT_CHANNEL_ACCESS, old.id)) await this.app.storage.putRecord({ namespace: BOT_CHANNEL_ACCESS, id: old.id,
          value: { version: 1, context: value.context, participants: [] } satisfies BotChannelAccess });
      }
    }
    if (value.conversationId && !await this.app.storage.getConversation(value.conversationId)) delete value.conversationId;
    if (value.conversationId) {
      let bound: ActorIdentity | undefined; try { bound = this.authorize(context); } catch { /* 普通旁观消息只记录内容。 */ }
      if (bound) await addBotParticipant(this.app, value.conversationId, context, bound.id);
    }
    const profile = botProfile(settings, context.platform, context);
    return { id, revision: record.revision, value, actor, profile: { ...profile, ...value.selection } };
  }
  async current(loaded: LoadedSession): Promise<PlatformConversation | undefined> {
    if (!loaded.value.conversationId) return undefined;
    const value = await this.app.storage.getConversation(loaded.value.conversationId);
    if (!value) { delete loaded.value.conversationId; return undefined; }
    return this.app.conversation(loaded.actor.id, value.id);
  }
  async snapshot(context: BotContext) {
    const loaded = await this.load(context); const conversation = await this.current(loaded);
    const run = conversation ? (await this.app.storage.listRuns({ conversationId: conversation.id, limit: 1 }))[0] : undefined;
    const settings = this.app.settings.snapshot().settings;
    const agent = settings.agents.find(item => item.id === loaded.profile.agentId);
    const provider = settings.providers.find(item => item.id === (loaded.profile.providerId ?? agent?.providerId));
    const workspaceId = conversation?.workspaceId ?? loaded.profile.workspaceId;
    const workspace = settings.workspaces.find(item => item.id === workspaceId);
    const inRoute = async (runId: string) => {
      const target = await this.app.storage.getRun(runId);
      const route = target && await this.routeForRun(context.platform, target);
      return route?.botId === context.botId && route.channelId === context.channelId;
    };
    const questions = (await Promise.all(this.app.runtime.pendingQuestions().map(async item =>
      (item.actorId === loaded.actor.id || loaded.actor.role === 'owner') && await inRoute(item.runId) ? item : null))).filter(item => item !== null);
    const approvals = (await Promise.all(this.app.runtime.pendingApprovals().map(async item =>
      (item.actorId === loaded.actor.id || loaded.actor.role === 'owner' || loaded.actor.effects.includes('administration')) && await inRoute(item.runId) ? item : null))).filter(item => item !== null);
    return { loaded, conversation, run, active: active(run), provider, model: loaded.profile.modelId ?? agent?.modelId ?? provider?.model, workspace, questions, approvals };
  }
  workspaces(actorId: string) {
    return this.app.settings.snapshot().settings.workspaces.filter(workspace => {
      try { this.app.workspace(actorId, workspace.id, ['workspace_read']); return true; } catch { return false; }
    });
  }
  models(actorId: string) {
    this.app.requireOwner(actorId);
    return this.app.settings.snapshot().settings.providers.flatMap(provider => {
      const values = new Map(provider.models.map(model => [model.id, model.name || model.id]));
      if (provider.model && !values.has(provider.model)) values.set(provider.model, provider.model);
      return [...values].map(([modelId, name]) => ({ providerId: provider.id, modelId, label: name, providerName: provider.name }));
    });
  }
  async conversations(actorId: string, context: BotContext) {
    const hidden = this.app.subagents.childConversationIds();
    const page = await this.app.storage.listConversations({ limit: 200 });
    const values = await Promise.all(page.items.filter(item => !hidden.has(item.id)).map(async item => {
      try {
        await this.app.conversation(actorId, item.id);
        const access = await this.app.storage.getRecord(BOT_CHANNEL_ACCESS, item.id) as BotChannelAccess | null;
        return access && sameBotChannel(access.context, context) ? item : null;
      } catch { return null; }
    }));
    return values.filter((value): value is NonNullable<typeof value> => value !== null);
  }
  async routeForRun(platform: BotPlatform, run: RunRecord): Promise<BotRoute | null> {
    let current: RunRecord | null = run;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const exact = await this.app.storage.getRecord(botRouteNamespace, current.requestKey) as BotRoute | null;
      if (exact?.platform === platform) return exact;
      const metadata = await this.app.storage.getConversation(current.conversationId);
      const childId = (metadata?.custom as Record<string, unknown> | undefined)?.platformSubagentId;
      const child = typeof childId === 'string' ? await this.app.subagents.get(current.actorId, childId) : null;
      // 从旧记录手动启动的任务没有 Bot 回复路线，不从历史配置猜测发送目标。
      if (child) { current = child.parentRunId ? await this.app.storage.getRun(child.parentRunId) : null; continue; }
      if (current.continuationOf) { current = await this.app.storage.getRun(current.continuationOf); continue; }
      if (current.requestKey.startsWith(`${platform}:`)) return this.app.storage.getRecord(`${platform}-routes`, current.conversationId) as Promise<BotRoute | null>;
      return null;
    }
    return null;
  }
  async perform(context: BotContext, action: BotAction): Promise<{ reply: string; run?: RunRecord }> {
    this.authorize(context);
    return this.serial(context, () => this.execute(context, action));
  }
  async serial<T>(context: BotContext, operation: () => Promise<T>): Promise<T> {
    const key = this.key(context);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(operation);
    this.queues.set(key, work);
    try { return await work; } finally { if (this.queues.get(key) === work) this.queues.delete(key); }
  }
  private mutation(loaded: LoadedSession): RecordMutation {
    loaded.value.updatedAt = Date.now();
    return { namespace, id: loaded.id, ownerId: loaded.value.actorId, expectedRevision: loaded.revision, value: loaded.value };
  }
  private async runWorkspace(context: BotContext, loaded: LoadedSession, conversation: PlatformConversation) {
    let channelWorkspaceId = loaded.profile.workspaceId === null ? undefined : loaded.profile.workspaceId ?? (typeof conversation.workspaceId === 'string' ? conversation.workspaceId : undefined);
    if (!channelWorkspaceId && loaded.profile.workspaceId !== null) channelWorkspaceId = await this.app.botWorkspaces.get(context, conversation.id);
    if (channelWorkspaceId === `workspace-${conversation.id}` && !this.app.settings.snapshot().settings.workspaces.some(item => item.id === channelWorkspaceId)) {
      channelWorkspaceId = await this.app.botWorkspaces.get(context, conversation.id, { existingOnly: true, workspaceUri: conversation.workspaceUri });
    }
    let workspaceId = channelWorkspaceId;
    if (workspaceId) {
      const actor = await actorForBotRun(this.app, loaded.actor.id, { conversationId: conversation.id, workspaceId });
      const workspace = this.app.settings.snapshot().settings.workspaces.find(item => item.id === workspaceId);
      if (!actor || !workspace || authorizeEffects(actor, ['workspace_read'], workspace)) workspaceId = undefined;
    }
    return { channelWorkspaceId, workspaceId };
  }
  private runMetadata(conversation: PlatformConversation, context: BotContext, loaded: LoadedSession, channelWorkspaceId?: string) {
    const channelWorkspace = this.app.settings.snapshot().settings.workspaces.find(item => item.id === channelWorkspaceId);
    return { ...conversation, workspaceId: channelWorkspaceId, workspaceUri: channelWorkspace ? pathToFileURL(channelWorkspace.directory).toString() : undefined,
      custom: { ...conversation.custom as Record<string, unknown>, botEnvironment: captureBotEnvironment(this.app, context, loaded.profile, channelWorkspaceId) } };
  }
  async recordingConversation(context: BotContext) {
    const loaded = await this.load(context, true);
    let conversation = await this.current(loaded);
    if (!conversation) conversation = await this.create(context, loaded, `${context.platform === 'discord' ? 'Discord' : 'QQ'} · ${context.channelId}`);
    else if (loaded.revision === null) {
      await this.app.storage.commitRecords([this.mutation(loaded)]);
      loaded.revision = (await this.app.storage.getVersionedRecord(namespace, loaded.id)).revision;
    }
    return { loaded, conversation };
  }
  private async create(context: BotContext, loaded: LoadedSession, title: string) {
    const id = `bot_${botKey(loaded.id, context.id).slice(0, 40)}`;
    const existing = await this.app.storage.getConversation(id);
    if (existing) { await this.app.conversation(loaded.actor.id, id); loaded.value.conversationId = id; return existing; }
    const character = loaded.profile.character;
    if (character) {
      await this.app.characters.validateBindings(character.worldbookIds, character.regexIds);
      if (character.characterId && (await this.app.characters.get(character.characterId)).resource.kind !== 'character') throw new Error('Bot 角色卡不存在，请在桌面重新选择。');
    }
    const greeting = character ? await this.app.characterPipeline.greeting(character) : undefined;
    const workspaceId = loaded.profile.workspaceId === null ? undefined : loaded.profile.workspaceId ?? await this.app.botWorkspaces.get(context, id);
    if (workspaceId) this.app.workspace(this.owner().id, workspaceId, ['workspace_read']);
    loaded.value.conversationId = id;
    let participant: ActorIdentity | undefined; try { participant = this.authorize(context); } catch { /* 群背景消息没有执行权限。 */ }
    const result = await this.app.createConversation(this.owner().id, title, workspaceId, {
      platformMode: character ? 'character' : workspaceId ? 'code' : 'chat', botOrigin: { platform: context.platform, channelId: context.channelId },
      botEnvironment: captureBotEnvironment(this.app, context, loaded.profile, workspaceId),
      ...(loaded.profile.promptModeId ? { promptModeConfig: { modeId: loaded.profile.promptModeId } } : {}), ...(character ? { characterConfig: character } : {}),
    }, greeting ? [greeting] : [], { id, records: [this.mutation(loaded), { namespace: BOT_CHANNEL_ACCESS, id,
      value: { version: 1, context: loaded.value.context, participants: participant ? [{ actorId: participant.id, platformUserId: context.authorId }] : [] } satisfies BotChannelAccess }] });
    loaded.revision = (await this.app.storage.getVersionedRecord(namespace, loaded.id)).revision;
    return result;
  }
  async execute(context: BotContext, action: BotAction): Promise<{ reply: string; run?: RunRecord }> {
    const loaded = await this.load(context);
    const receiptId = botKey(context.platform, context.botId, context.id);
    const receipt = await this.app.storage.getRecord(receipts, receiptId) as { reply: string } | null;
    if (receipt) return { reply: receipt.reply };
    if (await this.app.storage.getRecord(`${context.platform}-receipts`, context.id)) return { reply: '' };
    let conversation = await this.current(loaded);
    let reply = ''; let run: RunRecord | undefined;
    const receiptRecord = (): RecordMutation => ({ namespace: receipts, id: receiptId, value: { receivedAt: Date.now(), reply } });
    if (action.kind === 'source') reply = distributionSourceNotice();
    else if (action.kind === 'help') reply = '使用 /gray 打开操作面板；失败任务可用 /gray-retry 重试。文字指令仍可用：/gray new、/gray retry、/gray task 对话ID、/gray workspace 工作区ID（none 为普通聊天）、/gray status、/gray cancel、/gray answer 提问ID 回答、/gray approve 审批ID、/gray deny 审批ID、/gray choose 审批ID 选项序号。\n/gray source 查看当前版本源码与许可。\n\n' + distributionSourceNotice();
    else if (action.kind === 'workspaces') reply = this.workspaces(loaded.actor.id).map(item => `${item.name} · ${item.id}`).join('\n') || '当前账号没有可用工作区。';
    else if (action.kind === 'workspace') {
      this.app.requireOwner(loaded.actor.id);
      const workspace = action.workspaceId ? this.app.workspace(loaded.actor.id, action.workspaceId, ['workspace_read']) : undefined;
      loaded.value.selection.workspaceId = workspace?.id ?? null;
      reply = workspace ? `后续任务将使用 ${workspace.name}，频道历史和已经运行的任务保持原样。` : '后续任务不绑定工作区，频道历史保持原样。';
    } else if (action.kind === 'model' || action.kind === 'model-default') {
      this.app.requireOwner(loaded.actor.id);
      if (action.kind === 'model') {
        const provider = this.app.settings.snapshot().settings.providers.find(item => item.id === action.providerId);
        if (!provider || !action.modelId.trim()) throw new Error('模型渠道已变化，请重新选择。');
        loaded.value.selection.providerId = action.providerId; loaded.value.selection.modelId = action.modelId;
        reply = `后续请求使用 ${provider.name} / ${action.modelId}，当前对话保持不变。`;
      } else {
        delete loaded.value.selection.providerId; delete loaded.value.selection.modelId;
        reply = '后续请求恢复使用这个入口的默认模型。';
      }
    } else if (action.kind === 'conversation') {
      this.app.requireOwner(loaded.actor.id);
      conversation = await this.app.conversation(loaded.actor.id, action.conversationId);
      const access = await this.app.storage.getRecord(BOT_CHANNEL_ACCESS, conversation.id) as BotChannelAccess | null;
      if (!access || !sameBotChannel(access.context, context)) throw new Error('只能切换到这个频道已有的 Bot 对话，其他对话请在桌面打开。');
      if (conversation.workspaceId) this.app.workspace(loaded.actor.id, String(conversation.workspaceId), ['workspace_read']);
      loaded.value.conversationId = conversation.id;
      loaded.value.selection.workspaceId = typeof conversation.workspaceId === 'string' ? conversation.workspaceId : null;
      reply = `已选择「${conversation.title || '未命名对话'}」。`;
    } else if (action.kind === 'new') {
      this.app.requireOwner(loaded.actor.id);
      conversation = await this.create(context, loaded, context.platform === 'discord' ? 'Discord 对话' : 'QQ 对话');
      reply = '已建立新对话，下一条消息会从这里开始。';
    } else if (action.kind === 'approval' || action.kind === 'answer') {
      const target = action.kind === 'approval' ? this.app.runtime.pendingApprovals().find(item => item.id === action.approvalId)
        : this.app.runtime.pendingQuestions().find(item => item.id === action.questionId);
      const targetRun = target ? await this.app.storage.getRun(target.runId) : null;
      const route = targetRun && await this.routeForRun(context.platform, targetRun);
      if (!target || !route || route.botId !== context.botId || route.channelId !== context.channelId) throw new Error('这个请求不属于当前入口，或已经结束。');
      if (action.kind === 'approval') {
        let choiceId = action.choiceId;
        if (action.choiceIndex !== undefined) {
          const choice = Number.isSafeInteger(action.choiceIndex) && (target as ApprovalRequest).choices?.[action.choiceIndex];
          if (!choice) throw new Error('请选择列出的选项序号。');
          choiceId = choice.id;
        }
        await this.app.runtime.resolveApproval(action.approvalId, loaded.actor.id, action.accepted, choiceId);
      } else await this.app.runtime.answerQuestion(action.questionId, loaded.actor.id, action.answers);
      reply = '已提交。';
    } else {
      let latest = conversation ? (await this.app.storage.listRuns({ conversationId: conversation.id, limit: 1 }))[0] : undefined;
      if (action.kind === 'status') reply = latest ? `「${conversation!.title}」\n${botRunLabels[latest.status]} · 第 ${latest.iteration} 轮\n对话 ID：${conversation!.id}` : conversation ? '这段对话还没有任务。' : '当前还没有选择对话。';
      else if (action.kind === 'cancel') {
        if (active(latest)) await this.app.runtime.cancel(latest!.id, loaded.actor.id);
        reply = active(latest) ? '已请求停止当前任务。' : '当前没有可停止的任务。';
      } else if (action.kind === 'interrupt') {
        if (!conversation || !active(latest)) throw new Error('当前没有运行中的任务，请直接发送新消息。');
        await this.app.productUi.call({ actorId: loaded.actor.id, clientId: `bot-${loaded.id}` }, 'chat.sendInterruptMessage', { conversationId: conversation.id, text: action.text });
        reply = '追加说明已交给当前任务。';
      } else if (action.kind === 'retry') {
        if (context.platform !== 'discord') throw new Error('当前只支持从 Discord 重试任务。');
        if (!conversation || !latest || !['failed', 'interrupted'].includes(latest.status)) throw new Error('当前对话没有可重试的失败任务。');
        const originalRoute = await this.app.storage.getRecord(botRouteNamespace, latest.requestKey) as BotRoute | null;
        if (!originalRoute || originalRoute.platform !== context.platform || originalRoute.botId !== context.botId
          || originalRoute.channelId !== context.channelId || originalRoute.platformUserId !== context.authorId
          || latest.actorId !== loaded.actor.id) throw new Error('只能重试你在当前频道发起的任务。');
        const state = await this.app.conversations.read(loaded.actor.id, conversation.id);
        const { channelWorkspaceId, workspaceId } = await this.runWorkspace(context, loaded, conversation);
        const requestKey = `${context.platform}:${context.id}`;
        const route: BotRoute = { platform: context.platform, botId: context.botId, channelId: context.channelId, actorId: loaded.actor.id,
          conversationId: conversation.id, platformUserId: context.authorId, direct: context.direct,
          ...(context.sourceMessageId ? { replyToMessageId: context.sourceMessageId } : {}),
          output: { ...discordOutput(this.app.settings.snapshot().settings.discord), ...loaded.profile.output } };
        run = await this.app.runtime.continue({ actorId: loaded.actor.id, conversationId: conversation.id, agentId: latest.agentId,
          workspaceId, requestKey, expectedRevision: state.history.revision }, { state, commit: {
          metadata: this.runMetadata(state.metadata, context, loaded, channelWorkspaceId),
          records: [this.mutation(loaded), receiptRecord(), { namespace: botRouteNamespace, id: requestKey, ownerId: conversation.id, value: route }],
        } });
        return { reply: '', run };
      } else if (action.kind === 'message') {
        if (active(latest)) return { reply: '当前任务仍在执行，可用 /gray 查看状态、追加说明，或新建另一段对话。' };
        if (!action.text.trim()) throw new Error('请输入消息。');
        if (!conversation) conversation = await this.create(context, loaded, `${context.platform === 'discord' ? 'Discord' : 'QQ'} · ${action.text.slice(0, 48)}`);
        const agent = await captureBotAgent(this.app, loaded.actor.id, conversation.id, loaded.profile);
        const { channelWorkspaceId, workspaceId } = await this.runWorkspace(context, loaded, conversation);
        const requestKey = `${context.platform}:${context.id}`;
        const route: BotRoute = { platform: context.platform, botId: context.botId, channelId: context.channelId, actorId: loaded.actor.id,
          conversationId: conversation.id, platformUserId: context.authorId, network: context.network, direct: context.direct,
          ...(action.input ? { replyToMessageId: context.sourceMessageId ?? (context.platform === 'discord' ? context.id : undefined) } : {}),
          ...(context.platform === 'discord' ? { output: { ...discordOutput(this.app.settings.snapshot().settings.discord), ...loaded.profile.output } } : {}) };
        const state = await this.app.conversations.read(loaded.actor.id, conversation.id);
        const metadata = this.runMetadata(state.metadata, context, loaded, channelWorkspaceId);
        run = await this.app.runtime.start({ requestKey, actorId: loaded.actor.id, conversationId: conversation.id, workspaceId, agentId: agent.id,
          message: { role: 'user', parts: action.input?.message.parts ?? [{ text: action.text }] } }, { state,
          messageMetadata: { ...action.input?.message, source: { ...(action.input?.message.source as Record<string, unknown> | undefined), platform: context.platform, messageId: context.id, platformUserId: context.authorId, displayName: context.authorName } },
          commit: { metadata, records: [this.mutation(loaded), receiptRecord(), ...(action.input ? this.inbox.consumed(action.input) : [await this.inbox.activity(conversation.id, context)]),
            { namespace: botRouteNamespace, id: requestKey, ownerId: conversation.id, value: route }] } });
        return { reply: '', run };
      }
    }
    await this.app.storage.commitRecords([this.mutation(loaded), receiptRecord()]);
    return { reply, run };
  }
  async close() { await Promise.allSettled(this.queues.values()); }
}

export function parseBotAction(text: string): BotAction {
  const command = /^\/gray(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!command) return { kind: 'message', text };
  const verb = command[1]?.toLowerCase(); const argument = command[2]?.trim() ?? '';
  if (!verb || verb === 'help') return { kind: 'help' };
  if (verb === 'status' || verb === 'source' || verb === 'new' || verb === 'cancel' || verb === 'retry' || verb === 'workspaces') return { kind: verb };
  if (verb === 'workspace') return argument ? { kind: 'workspace', workspaceId: argument === 'none' ? null : argument } : { kind: 'workspaces' };
  if (verb === 'task') return { kind: 'conversation', conversationId: argument };
  if (verb === 'ask' || verb === 'interrupt') return { kind: verb === 'ask' ? 'message' : 'interrupt', text: argument };
  const [id, ...rest] = argument.split(/\s+/);
  if (verb === 'answer') return { kind: 'answer', questionId: id, answers: rest.join(' ').split('|').map(value => value.trim()) };
  if (verb === 'approve' || verb === 'deny') return { kind: 'approval', approvalId: id, accepted: verb === 'approve' };
  if (verb === 'choose') return { kind: 'approval', approvalId: id, accepted: false, choiceIndex: Number(rest[0]) - 1 };
  return { kind: 'help' };
}
