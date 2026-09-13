import type { ConversationState, PlatformMessage } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import type { ContextConversationStore } from '../../../../backend/modules/api/chat/services/contextTrim/ports';
import { formatHistoryForAPI } from '../../../../backend/modules/conversation/manager/historyFormatting';

/** Original context services read and update this snapshot; one commit publishes all changes. */
export class CapturedContext {
  readonly state: ConversationState;
  dirty = false;
  readonly store: ContextConversationStore;
  constructor(state: ConversationState, filterHistory?: (messages: PlatformMessage[]) => PlatformMessage[]) {
    this.state = structuredClone(state);
    const updateMessage: ContextConversationStore['updateMessage'] = async (_id, index, updates) => {
      const message = this.state.history.messages[index];
      if (!message) throw new Error('Token update refers to an unavailable message.');
      this.state.history.messages[index] = { ...message, ...structuredClone(updates) } as PlatformMessage;
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
