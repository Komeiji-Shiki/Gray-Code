import type { ConversationSummary } from './index';
import type { RunRecord } from './runtime';
export interface ConversationViewInfo { id: string; conversationId: string | null; title: string; isStreaming: boolean; hasDraft: boolean; active: boolean }
export interface ConversationNavigationItem extends Omit<ConversationSummary, 'revision'> { workspaceIdentity?: string; pinnedAt?: number; automaticWorkspace?: boolean; projectName?: string }
export type NavigationOrderKind = 'groups' | 'conversations' | 'pinned' | 'drafts';
export interface NavigationOrdering {
  revision: number; groups: string[]; conversations: string[]; pinned: string[]; drafts: string[];
}
export interface ConversationNavigationCursor {
  orderedOffset: number; orderingRevision: number; recent?: { updatedAt: number; id: string };
}
export interface ConversationNavigationResult {
  items: ConversationNavigationItem[]; pinned: ConversationNavigationItem[];
  workspaces: Array<{ id: string; name: string; directory: string; uri: string }>;
  runs: Pick<RunRecord, 'id' | 'conversationId' | 'status'>[];
  ordering?: NavigationOrdering;
  nextCursor?: ConversationNavigationCursor;
}
