import type { ActorIdentity, AppSettings, BotMessagePolicy, BotOutputSettings, DiscordOutputSettings, DiscordReplyProfile, DiscordSettings, DiscordTrigger, OneBotSettings } from '@graycode/contracts';
import type { BotInbound } from './gateway';

export const discordTriggers: DiscordTrigger[] = ['mention', 'reply', 'mention_or_reply', 'keyword', 'all', 'command'];
export function discordTrigger(config: DiscordSettings | OneBotSettings, channelId: string): DiscordTrigger {
  return config.channels?.[channelId]?.trigger ?? config.defaultTrigger ?? (config.mentionOnly ? 'mention' : 'all');
}
export function discordNeedsMessageContent(config: DiscordSettings): boolean {
  return config.allowedChannelIds.length > 0;
}
export function discordAdmitted(config: DiscordSettings, source: Pick<BotInbound, 'direct' | 'channelId'>, actor: ActorIdentity): boolean {
  if (!config.enabled || actor.revoked) return false;
  return source.direct ? actor.role === 'owner' && config.directMessages?.enabled !== false : config.allowedChannelIds.includes(source.channelId);
}
export function discordTriggered(config: DiscordSettings | OneBotSettings, source: BotInbound, text: string): boolean {
  if (source.direct || /^\/gray(?:\s|$)/i.test(text)) return true;
  switch (discordTrigger(config, source.channelId)) {
    case 'mention': return source.mentioned;
    case 'reply': return source.repliedToBot === true;
    case 'mention_or_reply': return source.mentioned || source.repliedToBot === true;
    case 'all': return true;
    case 'keyword': return (config.channels?.[source.channelId]?.keywords ?? []).some(keyword => text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
    case 'command': return false;
  }
}
export function botMessagePolicy(config: DiscordSettings | OneBotSettings, channelId: string, direct = false): BotMessagePolicy {
  if (direct) return { mergeWindowMs: 0, cooldownMs: 0, maxPending: 0 };
  return { mergeWindowMs: 0, cooldownMs: 0, maxPending: 0, ...config.messagePolicy, ...config.channels?.[channelId]?.messagePolicy };
}
export function discordProfile(config: DiscordSettings, source: Pick<BotInbound, 'direct' | 'channelId'>): DiscordReplyProfile {
  const defaults = config.defaultProfile;
  const override = source.direct ? config.directMessages?.profile : config.channels?.[source.channelId]?.profile;
  const merged = { agentId: config.agentId, workspaceId: config.workspaceId, ...defaults, ...override };
  if (defaults?.output || override?.output) merged.output = { ...defaults?.output, ...override?.output };
  // 切换渠道后，未另选模型时使用新渠道的默认模型，避免沿用另一个渠道的模型 ID。
  if (override?.providerId && override.providerId !== defaults?.providerId && !override.modelId) delete merged.modelId;
  return merged;
}
export function botProfile(settings: Pick<AppSettings, 'discord' | 'onebot'>, platform: 'discord' | 'onebot', source: Pick<BotInbound, 'direct' | 'channelId'>): DiscordReplyProfile {
  if (platform === 'discord') return discordProfile(settings.discord, source);
  const config = settings.onebot!;
  const defaults = config.defaultProfile;
  const override = source.direct ? config.directMessages?.profile : config.channels?.[source.channelId]?.profile;
  const merged = { agentId: config.agentId, workspaceId: config.workspaceId, ...defaults, ...override };
  if (defaults?.output || override?.output) merged.output = { ...defaults?.output, ...override?.output };
  if (override?.providerId && override.providerId !== defaults?.providerId && !override.modelId) delete merged.modelId;
  return merged;
}
export function botOutput(settings: Pick<AppSettings, 'discord' | 'onebot'>, platform: 'discord' | 'onebot', profile?: DiscordReplyProfile): BotOutputSettings {
  const output = platform === 'discord' ? discordOutput(settings.discord) : settings.onebot?.output
    ?? { streaming: false, updateIntervalMs: 1000, showThoughts: false, showToolStatus: false, longReplies: 'split' as const };
  return { ...output, ...profile?.output };
}
export function discordOutput(config: DiscordSettings): DiscordOutputSettings {
  // 没有新增输出配置的旧存档继续采用完成后发送；新配置的选择由设置页保存。
  return config.output ?? { streaming: false, updateIntervalMs: 1000, showThoughts: false, showToolStatus: false, longReplies: 'split' };
}

export function validateDiscordSettings(settings: AppSettings): void {
  const config = settings.discord;
  const output = (value: BotOutputSettings, label: string, onebot = false) => {
    if ([value.streaming, value.showThoughts, value.showToolStatus].some(value => typeof value !== 'boolean')
      || !Number.isSafeInteger(value.updateIntervalMs) || value.updateIntervalMs < 1000 || value.updateIntervalMs > 60000
      || !(onebot ? ['split', 'file', 'forward'] : ['split', 'file']).includes(value.longReplies)) throw new Error(`${label}输出配置无效，更新间隔需要在 1 至 60 秒之间。`);
    if (onebot && value.streaming) throw new Error('OneBot 不支持编辑流式回复，请关闭流式输出。');
    if (onebot && settings.onebot?.protocolVersion === 12 && value.longReplies === 'forward') throw new Error('OneBot 12 不支持合并转发，请选择分段或文件。');
  };
  const policy = (value: Partial<BotMessagePolicy> | undefined) => {
    if (!value) return;
    for (const key of ['mergeWindowMs', 'cooldownMs', 'maxPending'] as const) {
      const number = value[key];
      if (number !== undefined && (!Number.isSafeInteger(number) || number < 0 || number > (key === 'mergeWindowMs' ? 10_000 : key === 'cooldownMs' ? 3_600_000 : 1000)))
        throw new Error('消息策略无效：合并窗口为 0 至 10 秒，冷却为 0 至 3600 秒，排队上限为 0 至 1000 条，0 表示关闭。');
    }
  };
  const profile = (value: DiscordReplyProfile | undefined, label: string, onebot = false) => {
    if (!value) return;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}配置必须是对象。`);
    if (value.output) output(botOutput(settings, onebot ? 'onebot' : 'discord', value), label, onebot);
    if (value.agentId && !settings.agents.some(agent => agent.id === value.agentId)) throw new Error(`${label}选择的智能体不存在。`);
    if (value.providerId && !settings.providers.some(provider => provider.id === value.providerId)) throw new Error(`${label}选择的模型渠道不存在。`);
    if (value.modelId !== undefined && (typeof value.modelId !== 'string' || !value.modelId.trim())) throw new Error(`${label}请选择有效模型。`);
    if (value.workspaceId && !settings.workspaces.some(workspace => workspace.id === value.workspaceId)) throw new Error(`${label}选择的工作区不存在。`);
    if (value.toolsEnabled !== undefined && typeof value.toolsEnabled !== 'boolean') throw new Error(`${label}的工具开关无效。`);
    if (value.maxIterations !== undefined && (!Number.isSafeInteger(value.maxIterations) || value.maxIterations !== -1 && value.maxIterations < 1)) throw new Error(`${label}的工具迭代上限应为正整数，或 -1 表示不限制。`);
    if (value.idleMinutes !== undefined && (!Number.isFinite(value.idleMinutes) || value.idleMinutes < 0)) throw new Error(`${label}的空闲时间应为非负分钟数。`);
    if (value.environmentEntry) {
      const entry = value.environmentEntry;
      if (typeof entry.enabled !== 'boolean' || typeof entry.content !== 'string' || typeof entry.identityTemplate !== 'string'
        || entry.content.length > 100000 || entry.identityTemplate.length > 100000) throw new Error(`${label}的 Bot 环境条目无效，单段文字上限为十万字符。`);
      if (entry.content.includes('{{$TASK_CONTEXT}}')) throw new Error(`${label}：请把当前发言人变量写入“当轮身份说明”，频道环境只使用稳定的 BOT_CONTEXT。`);
    }
    if (value.autoSummary) {
      const summary = value.autoSummary;
      if (summary.method !== undefined && !['time', 'summary', 'notes'].includes(summary.method)) throw new Error(`${label}请选择普通总结或笔记换窗口。`);
      if (summary.timedEnabled !== undefined && typeof summary.timedEnabled !== 'boolean') throw new Error(`${label}的时间总结开关无效。`);
      if (typeof summary.enabled !== 'boolean' || !['idle', 'interval'].includes(summary.trigger) || !Number.isFinite(summary.minutes) || summary.minutes < 1
        || !Number.isFinite(summary.percent) || summary.percent < 1 || summary.percent > 99 || typeof summary.prompt !== 'string' || summary.prompt.length > 100000)
        throw new Error(`${label}的自动总结配置无效：时间至少 1 分钟，压缩比例为 1 至 99%。`);
    }
    if (value.character && (value.character.kind !== 'character' || typeof value.character.userName !== 'string' || typeof value.character.persona !== 'string'
      || !Array.isArray(value.character.worldbookIds) || !Array.isArray(value.character.regexIds) || !Number.isSafeInteger(value.character.scanDepth) || value.character.scanDepth < 0
      || value.character.worldTokenBudget !== undefined && (!Number.isSafeInteger(value.character.worldTokenBudget) || value.character.worldTokenBudget < 0))) throw new Error(`${label}的角色配置无效。`);
  };
  if (config.defaultTrigger && !discordTriggers.includes(config.defaultTrigger)) throw new Error('默认回复触发方式无效。');
  policy(config.messagePolicy);
  if (config.directMessages && typeof config.directMessages.enabled !== 'boolean') throw new Error('私聊开关无效。');
  profile(config.defaultProfile, '默认回复'); profile(config.directMessages?.profile, '主人私聊');
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    if (!/^\d+$/.test(id)) throw new Error('频道配置需要 Discord 数字频道 ID。');
    if (channel.trigger && !discordTriggers.includes(channel.trigger)) throw new Error(`频道 ${channel.name ?? id} 的触发方式无效。`);
    if (channel.keywords && (!Array.isArray(channel.keywords) || channel.keywords.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('关键词不能包含空白项。');
    if (discordTrigger(config, id) === 'keyword' && !channel.keywords?.length) throw new Error(`请为频道 ${channel.name ?? id} 填写触发关键词。`);
    profile(channel.profile, `频道 ${channel.name ?? id}`);
    policy(channel.messagePolicy);
  }
  if (config.output) output(config.output, 'Discord');
  if (settings.onebot) {
    const qq = settings.onebot;
    if (qq.defaultTrigger && !discordTriggers.includes(qq.defaultTrigger)) throw new Error('QQ 默认回复触发方式无效。');
    policy(qq.messagePolicy);
    if (qq.output) output(qq.output, 'QQ', true);
    profile(qq.defaultProfile, 'QQ 默认回复', true); profile(qq.directMessages?.profile, 'QQ 私聊', true);
    for (const [id, channel] of Object.entries(qq.channels ?? {})) {
      if (channel.trigger && !discordTriggers.includes(channel.trigger)) throw new Error(`QQ 会话 ${id} 的触发方式无效。`);
      if (channel.keywords && (!Array.isArray(channel.keywords) || channel.keywords.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('QQ 关键词不能包含空白项。');
      if (discordTrigger(qq, id) === 'keyword' && !channel.keywords?.length) throw new Error(`请为 QQ 会话 ${id} 填写触发关键词。`);
      policy(channel.messagePolicy); profile(channel.profile, `QQ 会话 ${id}`, true);
    }
  }
}
