import type { DiscordReplyProfile, PlatformMessage, WorkspaceDefinition, ActorIdentity } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotContext } from './sessions';
import { DEFAULT_BOT_ENVIRONMENT, renderBotTemplate } from '../../../../shared/botConversation';

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
export function botIdentityMessage(environment: CapturedBotEnvironment, actor: ActorIdentity, workspace?: WorkspaceDefinition): PlatformMessage | undefined {
  const text = renderBotTemplate(environment.identityTemplate, { BOT_CONTEXT: JSON.stringify(environment.channel),
    TASK_CONTEXT: JSON.stringify({ actor: { id: actor.id, displayName: actor.displayName, role: actor.role }, workspace }) }).trim();
  return text ? { role: 'user', parts: [{ text }] } : undefined;
}
