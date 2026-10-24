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
  readonly appendMessages: PlatformMessage[] = [];
  /** 本轮改过的自定义元数据键；提交时元数据被外部并发修改，只把这些键重放到最新元数据上。 */
  readonly customChanges = new Set<string>();
  readonly store: ContextConversationStore;
  constructor(state: ConversationState, filterHistory?: (messages: PlatformMessage[]) => PlatformMessage[]) {
    // 正文、附件和回合快照只读复用；元数据、消息头与计数字段独立，修改仍在提交后生效。
    // 边界切换也只更新消息头；仅中间插入需要重新保存顺序，正文与附件始终复用。
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
    const setCustomMetadata: ContextConversationStore['setCustomMetadata'] = async (_id, key, value) => this.updateCustom(key, value);
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

  /** 改写一个自定义元数据键，undefined 表示删除；已有键保持原位置。 */
  updateCustom(key: string, value: unknown): void {
    const custom = { ...this.state.metadata.custom as Record<string, unknown> };
    if (value === undefined) delete custom[key];
    else custom[key] = structuredClone(value);
    this.state.metadata.custom = custom;
    this.customChanges.add(key);
    this.dirty = true;
  }

  /** 摘要准备与预算校验都成功后一次接纳候选，失败不会留下半次窗口切换。 */
  adopt(candidate: CapturedContext): void {
    this.state.metadata = candidate.state.metadata;
    this.state.history = candidate.state.history;
    for (const key of candidate.customChanges) this.customChanges.add(key);
    this.dirty = candidate.dirty;
    this.historyReplaced = candidate.historyReplaced;
    this.messageUpdates.clear();
    for (const [index, message] of candidate.messageUpdates) this.messageUpdates.set(index, message);
    this.appendMessages.splice(0, this.appendMessages.length, ...candidate.appendMessages);
  }
}
