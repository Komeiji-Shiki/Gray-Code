import type { ConversationManager } from '../../../../conversation/ConversationManager';

/** State access required by context evaluation; the desktop supplies one captured transaction. */
export type ContextConversationStore = Pick<ConversationManager,
    'getHistoryRef' | 'getHistoryForAPIFrom' | 'getCustomMetadata' | 'setCustomMetadata' |
    'invalidateContextManagementState' | 'updateMessage' | 'updateMessagesBatch'>;
