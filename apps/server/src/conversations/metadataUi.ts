import type { UiRequestHandlers } from '@graycode/contracts';
import type { ConversationManager } from '../../../../backend/modules/conversation/ConversationManager';
import type { PlatformApplication } from '../application';

type MetadataRequestName = 'conversation.listConversations' | 'conversation.getConversationMetadata'
  | 'conversation.getConversationMetadataBatch' | 'conversation.getCustomMetadata' | 'conversation.setCustomMetadata';

/** 聊天元数据沿用现有 manager 的降级读取与串行写入，不改变自定义键或存档格式。 */
export function conversationMetadataUiHandlers(
  app: PlatformApplication, conversations: ConversationManager
): Pick<UiRequestHandlers, MetadataRequestName> {
  return {
    'conversation.listConversations': async () => {
      const hidden = app.subagents.childConversationIds();
      return (await conversations.listConversations()).filter(id => !hidden.has(id));
    },
    'conversation.getConversationMetadata': data => conversations.getMetadata(data.conversationId),
    'conversation.getConversationMetadataBatch': data => conversations.getConversationMetadataBatch(data.conversationIds),
    'conversation.getCustomMetadata': data => conversations.getCustomMetadata(data.conversationId, data.key),
    'conversation.setCustomMetadata': async data => {
      await conversations.setCustomMetadata(data.conversationId, data.key, data.value);
      return { success: true };
    }
  };
}
