import type { UiRequestHandlers } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';

type MetadataRequestName = 'conversation.listConversations' | 'conversation.getConversationMetadata'
  | 'conversation.getConversationMetadataBatch' | 'conversation.getCustomMetadata' | 'conversation.setCustomMetadata';

/** 聊天元数据全部通过平台存储的版本化路径读写，与运行时事务共享 metadataToken 校验。 */
export function conversationMetadataUiHandlers(
  app: PlatformApplication, client: ClientSession
): Pick<UiRequestHandlers, MetadataRequestName> {
  return {
    'conversation.listConversations': () => app.conversations.listIds(client.actorId),
    'conversation.getConversationMetadata': data => app.conversations.metadata(client.actorId, data.conversationId),
    'conversation.getConversationMetadataBatch': data => app.conversations.summaries(client.actorId, data.conversationIds),
    'conversation.getCustomMetadata': data => app.conversations.customMetadata(client.actorId, data.conversationId, data.key),
    'conversation.setCustomMetadata': data => app.conversations.setCustomMetadata(client.actorId, data.conversationId, data.key, data.value),
  };
}
