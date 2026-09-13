export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
}

export interface BackupManifest {
  format: 'graycode-backup';
  version: 1 | 2;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  sourceDirectory: string;
  credentials: 'device' | 'password';
  conversations: number;
  messages: number;
  files: BackupFile[];
  exclusions: string[];
  resources?: { id: BackupCategoryId; version: 1; count: number }[];
}

export interface BackupProgress {
  operation: 'export' | 'restore';
  phase: 'snapshot' | 'resources' | 'archive' | 'verify' | 'ready' | 'cancelled' | 'error';
  message: string;
  processedBytes?: number;
  totalBytes?: number;
  filePath?: string;
}

export interface PendingBackupRestore {
  id: string;
  createdAt: number;
  sourcePath: string;
  stagingPath: string;
  previousPath: string;
  backupCreatedAt: number;
  conversations: number;
  messages: number;
  confirmed?: boolean;
  importPath?: string;
  preview?: BackupRestorePreview;
  selection?: BackupRestoreSelectionPlan;
  error?: string;
  requiresSelection?: boolean;
  unavailableCredentials?: string[];
}

/** 选择性恢复以完整会话、记忆范围和独立记录为最小单元。 */
export interface BackupUnitReference {
  kind: 'conversation' | 'record' | 'memory' | 'long-memory';
  id: string;
  namespace?: string;
}
export interface BackupUnit extends BackupUnitReference {
  key: string;
  fingerprint: string;
  label: string;
  actorId?: string;
  workspaceId?: string;
  records?: number;
  scopeKind?: string;
  scopeKey?: string;
  realm?: string;
}
export interface BackupMergeGroup {
  id: string;
  conflict: 'keep' | 'replace';
  units: BackupUnitReference[];
  source: Record<string, string>;
  /** 预览时每个来源单元在目标库中的指纹；空值表示当时不存在。 */
  expected: Record<string, string | null>;
  remove?: BackupUnitReference[];
}
export interface BackupMergeResult { restored: string[]; kept: string[] }

export type BackupCategoryId = 'conversations' | 'settings' | 'memories' | 'devices' | 'pets' | 'screen' | 'skills' | 'other';
export interface BackupRestoreCategory {
  id: BackupCategoryId;
  name: string;
  description: string;
  count: number;
  conflicts: number;
  dependencies: { id: BackupCategoryId; reason: string }[];
  examples: { name: string; conflict: boolean }[];
}
export interface BackupRestorePreview {
  fingerprint: string;
  createdAt: number;
  categories: BackupRestoreCategory[];
  migrations: string[];
  unavailableCredentials?: string[];
}
export interface BackupRestoreSelection {
  mode: 'complete' | 'selective';
  categories?: { id: BackupCategoryId; conflict: 'keep' | 'replace' }[];
  expectedPreview: string;
}
export interface BackupRestoreSelectionPlan extends BackupRestoreSelection {
  groups: BackupMergeGroup[];
  directories: { name: string; conflict: 'keep' | 'replace'; source: string; expected: string | null }[];
  /** 设备身份与配对是一个整体，替换时校验整个当前类别。 */
  expectedDevices?: string;
  items?: { name: string; category: BackupCategoryId; action: 'restore' | 'keep'; dependency: boolean }[];
}
