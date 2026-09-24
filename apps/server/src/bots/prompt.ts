import type { DiscordReplyProfile, PlatformMessage, ActorIdentity } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotContext } from './sessions';
import { DEFAULT_BOT_ENVIRONMENT, LEGACY_BOT_IDENTITY_TEMPLATE, renderBotTemplate } from '../../../../shared/botConversation';

export interface CapturedBotEnvironment { version: 1; content: string; identityTemplate: string; channel: Record<string, unknown> }
/** 频道环境不混入当前时间、昵称或当前发言人，只有用户修改配置时才改变固定前缀。 */
export function captureBotEnvironment(app: PlatformApplication, context: BotContext, profile: DiscordReplyProfile, workspaceId?: string): CapturedBotEnvironment {
  const entry = profile.environmentEntry ?? DEFAULT_BOT_ENVIRONMENT;
  const workspace = app.settings.snapshot().settings.workspaces.find(item => item.id === workspaceId);
  const channel = { platform: context.platform === 'onebot' ? context.network ?? 'qq' : 'discord', botId: context.botId,
    channelId: context.channelId, direct: context.direct, ...(workspace ? { workspace: { id: workspace.id, directory: workspace.directory } } : {}) };
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
/** 只改模型请求副本，不改变 Discord 历史消息和页面上的原文。 */
export function prependBotIdentityToCurrentMessage(messages: PlatformMessage[], environment: CapturedBotEnvironment | undefined,
  actor: Pick<ActorIdentity, 'role'> | undefined): PlatformMessage[] {
  if (environment?.version !== 1 || !actor) return messages;
  const identity = botIdentityText(environment, actor);
  if (!identity) return messages;
  const index = messages.findLastIndex(message => message.isUserInput && message.role === 'user'
    && typeof message.parts[0]?.text === 'string' && String(message.parts[0].text).startsWith('[Discord 发言'));
  if (index < 0) return messages;
  const next = [...messages];
  const message = next[index];
  next[index] = { ...message, parts: [{ ...message.parts[0], text: `${identity}\n${message.parts[0].text}` }, ...message.parts.slice(1)] };
  return next;
}
