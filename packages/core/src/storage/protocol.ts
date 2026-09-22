import type { ValueProjection } from './objects';
import type { LongMemoryGraph } from '@graycode/contracts';
import type {
  ConversationSummary, HistoryPage, HistoryWriteOptions, PageOptions,
  PlatformConversation, PlatformMessage, StorageStatistics, StoredRecord, SnapshotMetadata, PlatformSnapshot,
  RunRecord, RunListOptions, RunEvent,
  VersionedRecord, RecordMutation,
  BackupUnit, BackupMergeGroup, BackupMergeResult,
  ConversationState, ConversationCommit, ConversationCommitResult,
} from '@graycode/contracts';
import type { MemoryScopeDefinition, MemoryScopeState, MemoryEntry, MemorySummary, MemoryWrite, MemoryWriteResult, MemoryRevision, MemoryImportPublish, MemoryImportBatch } from './memoryTypes';
import type { RunEventWrite } from './runs';
import type { LongMemoryScope, LongMemoryScopeState, LongMemoryWrite, LongMemoryWriteResult, LongMemoryQuery, LongMemoryRecall, LongMemoryRead, LongMemoryReadResult, LongMemoryTopic, LongMemoryRecord, LongMemoryVector, LongMemoryArchive, LongMemoryJob } from '@graycode/contracts';

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
  longMemoryScopes: { input: { actorId: string }; output: LongMemoryScopeState[] };
  longMemoryState: { input: LongMemoryScope; output: LongMemoryScopeState };
  longMemoryWrite: { input: LongMemoryWrite; output: LongMemoryWriteResult };
  longMemoryRecall: { input: LongMemoryQuery; output: LongMemoryRecall };
  longMemoryTopics: { input: import('@graycode/contracts').LongMemoryTopicQuery; output: import('@graycode/contracts').LongMemoryTopicPage };
  longMemoryBrowse: { input: import('@graycode/contracts').LongMemoryBrowse; output: import('@graycode/contracts').LongMemoryBrowseResult };
  longMemoryRead: { input: LongMemoryRead; output: LongMemoryReadResult };
  longMemoryGraph: { input: { scope: LongMemoryScope; id: string; version?: number; limit?: number }; output: LongMemoryGraph };
  longMemoryRevisions: { input: { scope: LongMemoryScope; id: string }; output: LongMemoryRecord[] };
  longMemoryInspect: { input: {scope:LongMemoryScope;id:string;version?:number}; output:{revisions:LongMemoryRecord[];sources:import('@graycode/contracts').LongMemorySource[];parents:LongMemoryRecord[];relations:LongMemoryRecord[];activeVersion?:number} };
  longMemorySources: {input:{scope:LongMemoryScope;references:Array<{id:string;version:number}>};output:import('@graycode/contracts').LongMemorySource[]};
  longMemoryRecordVersions: {input:{scope:LongMemoryScope;references:Array<{id:string;version?:number}>};output:LongMemoryRecord[]};
  longMemoryImpact: { input: { scope: LongMemoryScope; kind: 'source'|'record'; id: string; action: 'delete'|'retract' }; output: Array<{ kind:'source'|'record';id:string }> };
  longMemoryDeletedSources: { input: { scopes:LongMemoryScope[] }; output: import('@graycode/contracts').LongMemoryTombstone[] };
  longMemoryDeletionState: {input:undefined;output:{scopes:LongMemoryScopeState[];tombstones:import('@graycode/contracts').LongMemoryTombstone[]}};
  longMemoryVector: { input: { scope: LongMemoryScope; id: string; version: number; vector: LongMemoryVector }; output: boolean };
  longMemoryExport: { input: { scopes: LongMemoryScope[] }; output: LongMemoryArchive };
  longMemoryRestore: { input: { actorId: string; archive: LongMemoryArchive; publication?: RecordMutation[]; copyVectors?: Array<{scopeId:string;id:string;from:number;to:number}> }; output: { sources: number; records: number; skipped: number; tombstones: number } };
  longMemoryJobs: { input: { scopes: LongMemoryScope[]; status?: LongMemoryJob['status'] }; output: LongMemoryJob[] };
  longMemoryJob: {input:{scope:LongMemoryScope;id:string};output:LongMemoryJob|null};
  longMemoryEnqueue: { input: { scope: LongMemoryScope; job: LongMemoryJob }; output: LongMemoryJob };
  longMemoryJobTransition: { input: { scope: LongMemoryScope; id: string; action: 'start'|'retry'|'cancel'|'fail'|'interrupt'; error?: string;usage?:LongMemoryJob['usage'] }; output: LongMemoryJob | null };
  longMemoryJobFinish: { input: { scope: LongMemoryScope; id: string; write: LongMemoryWrite; usage?: LongMemoryJob['usage'];vectors?:Array<{id:string;version:number;vector:LongMemoryVector}> }; output: { applied: boolean; job: LongMemoryJob | null; result?: LongMemoryWriteResult } };
  memoryImportBatch: { input: MemoryImportBatch; output: MemoryScopeState };
  memoryImportPublish: { input: MemoryImportPublish; output: { skipped: boolean; configImported: boolean } };
  memoryScopes: { input: { actorId: string }; output: MemoryScopeState[] };
  memoryState: { input: MemoryScopeDefinition; output: MemoryScopeState };
  memoryEntries: { input: { scope: MemoryScopeDefinition; offset: number; limit: number; expectedRevision?: number }; output: MemoryEntry[] };
  memorySummaries: { input: { scope: MemoryScopeDefinition; lo?: number; hi?: number; expectedRevision?: number }; output: MemorySummary[] };
  memoryRevisions: { input: { scope: MemoryScopeDefinition; before?: number }; output: MemoryRevision[] };
  memoryWrite: { input: MemoryWrite; output: MemoryWriteResult };
  readConversationState: { input: { id: string; records?: { namespace: string; id: string }[]; cursor?: import('@graycode/contracts').RuntimeHistoryCursor }; output: ConversationState };
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
  getConversationInfo: { input: { id: string }; output: { metadata: PlatformConversation; metadataToken: string; messageCount: number; historyRevision: number } | null };
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
  backupInventory: { input: undefined; output: BackupUnit[] };
  mergeBackupUnits: { input: { sourceDirectory: string; groups: BackupMergeGroup[] }; output: BackupMergeResult };
  close: { input: undefined; output: void };
}

export type StorageMethod = keyof StorageOperations;
export interface StorageRequest { id: number; method: StorageMethod; input: unknown }
export type StorageReply =
  | { type: 'ready' }
  | { type: 'reply'; id: number; value: unknown }
  | { type: 'error'; id?: number; error: { code: string; message: string } };
