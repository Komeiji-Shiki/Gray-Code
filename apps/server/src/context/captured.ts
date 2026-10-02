import type { ConversationState, PlatformMessage } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import type { ContextConversationStore } from '../../../../backend/modules/api/chat/services/contextTrim/ports';
import { formatHistoryForAPI } from '../../../../backend/modules/conversation/manager/historyFormatting';

/** Original context services read and update this snapshot; one commit publishes all changes. */
export class CapturedContext {
  readonly state: ConversationState;
  dirty = false;
  historyReplaced = false;
  readonly messageUpdates = new Map<number, PlatformMessage>();
  readonly store: ContextConversationStore;
  constructor(state: ConversationState, filterHistory?: (messages: PlatformMessage[]) => PlatformMessage[]) {
    // 正文、附件和回合快照只读复用；元数据、消息头与计数字段独立，修改仍在提交后生效。
    // 总结等需要改写正文或父链的操作自行复制，普通工具迭代无需深拷贝整份长会话。
    this.state = { ...state, metadata: structuredClone(state.metadata), history: { ...state.history,
      messages: state.history.messages.map(message => ({ ...message,
        ...(message.tokenCountByChannel ? { tokenCountByChannel: { ...message.tokenCountByChannel } } : {}) })) } };
    const updateMessage: ContextConversationStore['updateMessage'] = async (_id, index, updates) => {
      const message = this.state.history.messages[index];
      if (!message) throw new Error('Token update refers to an unavailable message.');
      this.state.history.messages[index] = { ...message, ...structuredClone(updates) } as PlatformMessage;
      this.messageUpdates.set(index, this.state.history.messages[index]);
      this.dirty = true;
    };
    const setCustomMetadata: ContextConversationStore['setCustomMetadata'] = async (_id, key, value) => {
      this.state.metadata.custom = { ...this.state.metadata.custom as Record<string, unknown>, [key]: structuredClone(value) };
      this.dirty = true;
    };
    this.store = {
      getHistoryRef: async () => (filterHistory?.(this.state.history.messages) ?? this.state.history.messages) as Content[],
      getHistoryForAPIFrom: formatHistoryForAPI,
      getCustomMetadata: async (_id, key) => (this.state.metadata.custom as Record<string, unknown> | undefined)?.[key],
      setCustomMetadata,
      invalidateContextManagementState: async id => setCustomMetadata(id, 'trimState', null),
      updateMessage,
      updateMessagesBatch: async (id, updates) => { for (const item of updates) await updateMessage(id, item.messageIndex, item.updates); },
    };
  }
}
