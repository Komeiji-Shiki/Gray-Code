/** Platform contracts contain no Node, Electron, VS Code or UI dependencies. */
export * from './runtime';
export * from './providers';
export * from './settings';
export * from './characters';
export * from './bots';
export * from './navigation';
export * from './browser';
export * from './terminal';
export * from './remote';
export * from './teams';
export * from './files';
export * from './search';
export * from './search';
export * from './backups';
export * from './automations';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PlatformMessage {
  id?: string;
  role: string;
  parts: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface PlatformConversation {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  workspaceUri?: string;
  [key: string]: unknown;
}

export interface ConversationSummary {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  workspaceUri?: string;
  workspaceId?: string;
  botPlatform?: 'discord' | 'onebot';
  messageCount: number;
  revision: number;
}

export interface HistoryPage {
  conversationId: string;
  total: number;
  startIndex: number;
  revision: number;
  messages: PlatformMessage[];
}

export interface PageOptions {
  /** Exclusive ending position. Omit both positions to read the tail. */
  beforeIndex?: number;
  offset?: number;
  limit?: number;
}

export interface HistoryWriteOptions {
  /** Compare-and-swap revision. A stale editor cannot overwrite newer history. */
  expectedRevision?: number;
}

export interface StorageStatistics {
  schemaVersion: number;
  sqliteVersion: string;
  conversations: number;
  messages: number;
  objects: number;
  rawBytes: number;
  storedBytes: number;
  databaseBytes: number;
  walBytes: number;
}

export interface MigrationIssue {
  conversationId?: string;
  path: string;
  code: string;
  message: string;
}

/** 进度按实际阶段和已完成数量报告，不把阶段数当作数据量百分比。 */
export interface MigrationProgress {
  phase: 'scanning' | 'history' | 'artifacts' | 'memory' | 'skills' | 'activity' | 'runtimeAssets' | 'configuration' | 'finalizing';
  detail: string;
  currentItem?: string;
  conversationId?: string;
  completed?: number;
  total?: number;
  unit?: string;
  importedMessages?: number;
  processedBytes?: number;
  totalBytes?: number;
}

export interface MigrationStatus {
  active: boolean;
  operationId?: string;
  source?: string;
  state?: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  startedAt?: number;
  updatedAt?: number;
  progress?: MigrationProgress;
  error?: string;
}

export interface MigrationReport {
  source: string;
  imported: string[];
  skipped: string[];
  issues: MigrationIssue[];
  /** This stage imports conversation history; unsupported assets block full cutover. */
  pendingArtifacts: string[];
  readyForCutover: boolean;
  /** 已导入的旧附属数据统计；缺省表示旧迁移器未执行附属阶段。 */
  artifacts?: {
    branches: string[];
    usage: string[];
    diffs: string[];
    attachments: string[];
    checkpoints: string[];
    snapshots?: string[];
    subagents?: string[];
  };
}

export type StorageErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'REVISION_CONFLICT'
  | 'CORRUPT_DATA'
  | 'UNSUPPORTED_VERSION'
  | 'SOURCE_CHANGED'
  | 'STORAGE_CLOSED'
  | 'STORAGE_BUSY'
  | 'IO_ERROR';

export interface StoredRecord {
  namespace: string;
  id: string;
  ownerId?: string;
  value: unknown;
}

export interface VersionedRecord { value: unknown | null; revision: number | null }
export type RecordMutation = { namespace: string; id: string; expectedRevision?: number | null } &
  ({ ownerId?: string; value: unknown } | { delete: true });

export interface SnapshotMetadata {
  id: string;
  conversationId: string;
  timestamp: number;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface PlatformSnapshot extends SnapshotMetadata {
  history: PlatformMessage[];
}
export * from './conversationState';

export * from './development';
