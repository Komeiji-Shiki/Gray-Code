import type { PlatformConversation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

export function isChatConversation(conversation: PlatformConversation): boolean {
  const custom = conversation.custom as { platformMode?: string; botEnvironment?: unknown } | undefined;
  return (custom?.platformMode ?? 'chat') === 'chat' && !custom?.botEnvironment;
}

/** 陪伴、桌宠消息与屏幕感知共用账号和普通对话边界，旧对话未标注模式时仍按普通对话读取。 */
export async function requireOwnChatConversation(
  app: PlatformApplication,
  actorId: string,
  conversationId: string,
): Promise<PlatformConversation> {
  app.requireOwner(actorId);
  const conversation = await app.conversation(actorId, conversationId);
  if (conversation.actorId !== actorId || !isChatConversation(conversation)) {
    throw new Error('请选择当前账号自己的普通对话。');
  }
  return conversation;
}
