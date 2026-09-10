import type { ActorIdentity } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotContext } from './sessions';
import { discordAdmitted } from './config';

export const BOT_CHANNEL_ACCESS = 'bot-channel-access';
export type BotChannelIdentity = Pick<BotContext, 'platform' | 'botId' | 'channelId' | 'direct' | 'network'>;
export interface BotChannelAccess {
  version: 1;
  context: BotChannelIdentity;
  participants: Array<{ actorId: string; platformUserId: string }>;
}
export function sameBotChannel(left: BotChannelIdentity, right: BotChannelIdentity): boolean {
  return left.platform === right.platform && left.botId === right.botId && left.channelId === right.channelId
    && left.direct === right.direct && (left.network ?? 'qq') === (right.network ?? 'qq');
}

/** 只给经真实入口验证过的成员共享本频道历史，公开请求不能写入这份授权记录。 */
export async function canReadBotConversation(app: PlatformApplication, actor: ActorIdentity, conversationId: string): Promise<boolean> {
  const access = await app.storage.getRecord(BOT_CHANNEL_ACCESS, conversationId) as BotChannelAccess | null;
  if (!access || actor.revoked) return false;
  const settings = app.settings.snapshot().settings;
  const context = access.context;
  const bound = access.participants.some(participant => participant.actorId === actor.id && settings.bindings.some(binding =>
    binding.accountId === actor.id && binding.platform === context.platform && binding.platformUserId === participant.platformUserId
    && (context.platform !== 'onebot' || (binding.network ?? 'qq') === (context.network ?? 'qq'))));
  if (!bound) return false;
  return context.platform === 'discord' ? discordAdmitted(settings.discord, context, actor)
    : !!settings.onebot?.enabled && settings.onebot.allowedChannelIds.includes(context.channelId);
}

export async function addBotParticipant(app: PlatformApplication, conversationId: string, context: BotContext, actorId: string) {
  const record = await app.storage.getVersionedRecord(BOT_CHANNEL_ACCESS, conversationId);
  const value = record.value as BotChannelAccess | null;
  if (!value || !sameBotChannel(value.context, context)) throw new Error('这个入口没有共享会话授权，请由主人确认频道对话。');
  if (value.participants.some(participant => participant.actorId === actorId && participant.platformUserId === context.authorId)) return;
  await app.storage.commitRecords([{ namespace: BOT_CHANNEL_ACCESS, id: conversationId, expectedRevision: record.revision,
    value: { ...value, participants: [...value.participants, { actorId, platformUserId: context.authorId }] } }]);
}
