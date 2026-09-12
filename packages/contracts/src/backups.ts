export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
}

export interface BackupManifest {
  format: 'graycode-backup';
  version: 1;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  sourceDirectory: string;
  credentials: 'device' | 'password';
  conversations: number;
  messages: number;
  files: BackupFile[];
  exclusions: string[];
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
}
