import type { Content, ConversationHistory } from '../../../../conversation/types';
import type { GetHistoryOptions } from '../../../../conversation/manager/types';

/** State access required by context evaluation; the desktop supplies one captured transaction. */
export interface ContextConversationStore {
    getHistoryRef(conversationId: string): Promise<ConversationHistory>;
    getHistoryForAPIFrom(contents: ReadonlyArray<Content>, options?: GetHistoryOptions | boolean): ConversationHistory;
    getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
    setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
    invalidateContextManagementState(conversationId: string, reason: string): Promise<void>;
    updateMessage(conversationId: string, messageIndex: number, updates: Partial<Content>): Promise<void>;
    updateMessagesBatch(conversationId: string, updates: Array<{ messageIndex: number; updates: Partial<Content> }>): Promise<void>;
}
