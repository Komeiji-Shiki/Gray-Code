import type { DiscordReplyProfile, PlatformMessage, ActorIdentity } from '@graycode/contracts';
import type { BotContext } from './sessions';
import { DEFAULT_BOT_ENVIRONMENT, LEGACY_BOT_IDENTITY_TEMPLATE, renderBotTemplate } from '../../../../shared/botConversation';
import { deserializePromptContextCache } from '../../../../backend/modules/prompt/promptContextCache';

export interface CapturedBotEnvironment { version: 1; content: string; identityTemplate: string; channel: Record<string, unknown> }
/** 频道环境不混入当前时间、昵称或当前发言人，只有用户修改配置时才改变固定前缀。 */
export function captureBotEnvironment(context: BotContext, profile: DiscordReplyProfile): CapturedBotEnvironment {
  const entry = profile.environmentEntry ?? DEFAULT_BOT_ENVIRONMENT;
  const channel = { platform: context.platform === 'onebot' ? context.network ?? 'qq' : 'discord', botId: context.botId,
    channelId: context.channelId, direct: context.direct };
  return { version: 1, channel, content: entry.enabled ? renderBotTemplate(entry.content, { BOT_CONTEXT: JSON.stringify(channel) }) : '',
    identityTemplate: entry.identityTemplate };
}
export function botIdentityText(environment: CapturedBotEnvironment, actor: Pick<ActorIdentity, 'role'>): string {
  const role = { owner: '主人', member: '成员', guest: '访客' }[actor.role];
  const template = environment.identityTemplate === LEGACY_BOT_IDENTITY_TEMPLATE
    ? DEFAULT_BOT_ENVIRONMENT.identityTemplate : environment.identityTemplate;
  return renderBotTemplate(template, { TASK_CONTEXT: role,
    BOT_CONTEXT: String(environment.channel.platform ?? 'Bot') }).trim();
}
/** 旧会话已经渲染的环境可能含工作区路径；发送时只保留频道字段。 */
export function botEnvironmentText(environment: CapturedBotEnvironment): string {
  const { workspace: _workspace, ...channel } = environment.channel;
  return environment.content.replaceAll(JSON.stringify(environment.channel), JSON.stringify(channel)).trim();
}
/** 续跑旧 Bot 回合时，移除旧缓存中单独注入的频道环境消息。 */
export function withoutStandaloneBotEnvironment(messages: PlatformMessage[], environment: CapturedBotEnvironment | undefined): PlatformMessage[] {
  if (environment?.version !== 1) return messages;
  const content = botEnvironmentText(environment);
  const { workspace: _workspace, ...channel } = environment.channel;
  const channelJson = JSON.stringify(channel);
  const channelIndex = content.indexOf(channelJson);
  const oldPrefix = channelIndex < 0 ? '' : `${content.slice(0, channelIndex)}${channelJson.slice(0, -1)},"workspace":`;
  const oldSuffix = channelIndex < 0 ? '' : content.slice(channelIndex + channelJson.length);
  return messages.filter(message => {
    if (message.role !== 'user' || message.parts.length !== 1 || typeof message.parts[0].text !== 'string') return true;
    const text = message.parts[0].text;
    return text !== environment.content && text !== content && !(oldPrefix && text.startsWith(oldPrefix) && text.endsWith(oldSuffix));
  });
}
export function botContextPrefix(environment: CapturedBotEnvironment, actor: Pick<ActorIdentity, 'role'>): string {
  return [botEnvironmentText(environment), botIdentityText(environment, actor)].filter(Boolean).join('\n');
}
/** 只改模型请求副本；每条历史发言复用当时捕获的来源，界面仍显示原文。 */
export function applyBotContextPrefixes(messages: PlatformMessage[], environment: CapturedBotEnvironment | undefined,
  actor: Pick<ActorIdentity, 'role'> | undefined): PlatformMessage[] {
  const currentPrefix = environment?.version === 1 && actor ? botContextPrefix(environment, actor) : undefined;
  const sourceLabel = environment?.channel.platform === 'discord' ? 'Discord' : String(environment?.channel.platform ?? 'QQ');
  const index = currentPrefix ? messages.findLastIndex(message => message.isUserInput && message.role === 'user'
    && typeof message.parts[0]?.text === 'string' && String(message.parts[0].text).toLowerCase().startsWith(`[${sourceLabel.toLowerCase()} 发言`))
    : -1;
  return messages.map((message, position) => {
    if (message.role !== 'user' || typeof message.parts[0]?.text !== 'string') return message;
    const captured = message.botTaskContextEmbedded === true && typeof message.turnDynamicContext === 'string'
      ? deserializePromptContextCache(message.turnDynamicContext).inputPrefix : undefined;
    // 旧记录只按原规则处理当前发言，不猜测历史成员当时的权限或频道配置。
    const prefix = captured ?? (position === index ? currentPrefix : undefined);
    return prefix ? { ...message, parts: [{ ...message.parts[0], text: `${prefix}\n${message.parts[0].text}` }, ...message.parts.slice(1)] } : message;
  });
}
