import type { HistoryPage, PlatformConversation, PlatformMessage, RecordMutation, SnapshotMetadata, VersionedRecord } from './index';
import type { RunRecord } from './runtime';

export interface ConversationState {
  metadata: PlatformConversation;
  metadataToken: string;
  history: HistoryPage;
  records: { namespace: string; id: string; record: VersionedRecord }[];
}
/** 模型循环确认上一次读取的版本，后续只传递发生变化的历史后缀。 */
export interface RuntimeHistoryCursor { runId: string; revision?: number }
/** Trusted service operation. Public clients never submit arbitrary records or run identities. */
export interface ConversationCommit {
  conversationId: string;
  expectedRevision: number;
  expectedMetadataToken?: string;
  messages?: PlatformMessage[];
  /** 保持消息位置的局部更新，与 messages 整体替换互斥。 */
  messageUpdates?: { index: number; message: PlatformMessage }[];
  metadata?: PlatformConversation;
  records?: RecordMutation[];
  /** Snapshot the previous history in the same transaction as its replacement. */
  snapshot?: SnapshotMetadata;
  /** Only this already active run may mutate the conversation, e.g. to commit a summary. */
  activeRunId?: string;
  /** 文件协调服务持有的持久操作标识，其他历史变更必须等待其完成。 */
  workspaceOperationId?: string;
  /** Reserve a new run atomically with an edit/retry. Duplicate requests do not mutate history. */
  startRun?: { run: RunRecord; message?: PlatformMessage };
}
export interface ConversationCommitResult {
  revision: number;
  total: number;
  metadataToken: string;
  records: { namespace: string; id: string; revision: number | null }[];
  run?: { run: RunRecord; created: boolean };
}
