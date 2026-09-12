import type { ValueProjection } from './objects';
import type {
  ConversationSummary, HistoryPage, HistoryWriteOptions, PageOptions,
  PlatformConversation, PlatformMessage, StorageStatistics, StoredRecord, SnapshotMetadata, PlatformSnapshot,
  RunRecord, RunListOptions, RunEvent,
  VersionedRecord, RecordMutation,
  ConversationState, ConversationCommit, ConversationCommitResult,
} from '@graycode/contracts';
import type { MemoryScopeDefinition, MemoryScopeState, MemoryEntry, MemorySummary, MemoryWrite, MemoryWriteResult, MemoryRevision, MemoryImportPublish, MemoryImportBatch } from './memoryTypes';
import type { RunEventWrite } from './runs';

export interface HistoryWriteResult { revision: number; total: number }
export interface ConversationListOptions {
  limit?: number;
  workspaceUri?: string;
  query?: string;
  cursor?: { updatedAt: number; id: string };
}
export interface ConversationList {
  items: ConversationSummary[];
  nextCursor?: { updatedAt: number; id: string };
}
export interface MigrationState { nextIndex: number; complete: boolean }

export interface StorageOperations {
  memoryImportBatch: { input: MemoryImportBatch; output: MemoryScopeState };
  memoryImportPublish: { input: MemoryImportPublish; output: { skipped: boolean; configImported: boolean } };
  memoryScopes: { input: { actorId: string }; output: MemoryScopeState[] };
  memoryState: { input: MemoryScopeDefinition; output: MemoryScopeState };
  memoryEntries: { input: { scope: MemoryScopeDefinition; offset: number; limit: number; expectedRevision?: number }; output: MemoryEntry[] };
  memorySummaries: { input: { scope: MemoryScopeDefinition; lo?: number; hi?: number; expectedRevision?: number }; output: MemorySummary[] };
  memoryRevisions: { input: { scope: MemoryScopeDefinition; before?: number }; output: MemoryRevision[] };
  memoryWrite: { input: MemoryWrite; output: MemoryWriteResult };
  readConversationState: { input: { id: string; records?: { namespace: string; id: string }[] }; output: ConversationState };
  commitConversation: { input: ConversationCommit; output: ConversationCommitResult };
  createRun: { input: { run: RunRecord; message: PlatformMessage; expectedRevision?: number }; output: { run: RunRecord; created: boolean } };
  getRun: { input: { id: string }; output: RunRecord | null };
  getRunByRequestKey: { input: { requestKey: string }; output: RunRecord | null };
  listRuns: { input: RunListOptions; output: RunRecord[] };
  appendRunEvent: { input: RunEventWrite; output: RunEvent };
  readRunEvents: { input: { runId: string; after?: number; limit?: number }; output: RunEvent[] };
  createConversation: { input: PlatformConversation; output: ConversationSummary };
  initializeConversation: { input: { metadata: PlatformConversation; messages: PlatformMessage[]; records: RecordMutation[] }; output: ConversationSummary };
  getConversation: { input: { id: string }; output: PlatformConversation | null };
  saveMetadata: { input: PlatformConversation; output: void };
  listConversations: { input: ConversationListOptions; output: ConversationList };
  readHistory: { input: { id: string; options?: PageOptions }; output: HistoryPage };
  historyInfo: { input: { id: string }; output: HistoryWriteResult };
  readUsageState: { input: { id: string; records?: { namespace: string; id: string; projection?: ValueProjection }[] }; output: { revision: number; messages: PlatformMessage[]; records: { namespace: string; id: string; record: VersionedRecord }[] } };
  recordRevisions: { input: { records: { namespace: string; id: string }[] }; output: (number | null)[] };
  readFullHistory: { input: { id: string }; output: HistoryPage };
  appendHistory: { input: { id: string; messages: PlatformMessage[]; options?: HistoryWriteOptions }; output: HistoryWriteResult };
  replaceHistory: { input: { id: string; messages: PlatformMessage[]; options?: HistoryWriteOptions }; output: HistoryWriteResult };
  forkConversation: { input: { sourceId: string; metadata: PlatformConversation; beforeIndex?: number; expectedRevision?: number; records?: RecordMutation[] }; output: ConversationSummary };
  deleteConversation: { input: { id: string }; output: boolean };
  saveSnapshot: { input: { metadata: SnapshotMetadata; messages?: PlatformMessage[] }; output: void };
  getSnapshot: { input: { id: string }; output: PlatformSnapshot | null };
  listSnapshots: { input: { conversationId: string }; output: string[] };
  deleteSnapshot: { input: { id: string }; output: boolean };
  putRecord: { input: StoredRecord; output: void };
  getVersionedRecord: { input: { namespace: string; id: string; projection?: ValueProjection }; output: VersionedRecord };
  commitRecords: { input: RecordMutation[]; output: { namespace: string; id: string; revision: number | null }[] };
  getRecord: { input: { namespace: string; id: string }; output: unknown | null };
  listRecords: { input: { namespace: string; ownerId?: string }; output: string[] };
  readRecordPage: { input: { namespace: string; ownerId: string; afterId?: string; limit: number }; output: StoredRecord[] };
  deleteRecord: { input: { namespace: string; id: string }; output: boolean };
  migrationBegin: { input: { sourceKey: string; fingerprint: string; metadata: PlatformConversation }; output: MigrationState };
  migrationAppend: { input: { sourceKey: string; offset: number; messages: PlatformMessage[] }; output: MigrationState };
  migrationFinish: { input: { sourceKey: string; fingerprint: string; total: number }; output: void };
  statistics: { input: undefined; output: StorageStatistics };
  collectGarbage: { input: undefined; output: { objectsRemoved: number; chunksRemoved: number; externalFilesRemoved: number } };
  verify: { input: undefined; output: { ok: boolean; issues: string[]; objectsChecked: number } };
  checkpoint: { input: undefined; output: void };
  backupSnapshot: { input: undefined; output: { directory: string; createdAt: number; statistics: StorageStatistics } };
  close: { input: undefined; output: void };
}

export type StorageMethod = keyof StorageOperations;
export interface StorageRequest { id: number; method: StorageMethod; input: unknown }
export type StorageReply =
  | { type: 'ready' }
  | { type: 'reply'; id: number; value: unknown }
  | { type: 'error'; id?: number; error: { code: string; message: string } };
