export const MEMORY_IMPORT_NAMESPACE = 'long-memory-import';
export const MEMORY_IMPORT_FILE_NAMESPACE = 'long-memory-import-file';
export const MEMORY_IMPORT_POLICY_NAMESPACE = 'long-memory-import-policy';

export interface MemoryImportFile {
  id: string; path: string; bytes: number; sha256: string; mimeType: string; chunks: number;
  modifiedAt?: string; createdAt?: string;
}
export interface MemoryImportDataset {
  id: string; actorId: string; name: string; scopeId: string; fingerprint: string;
  format: 'lifebook'; version: 1; importedAt: number;
  files: MemoryImportFile[]; originalFileCount: number; bytes: number; records: number; sources: number;
  graph?: { entities: number; facts: number; episodes: number; connections: number };
  segments: Array<{ fileId: string; sourceId: string; recordId: string; start: number; end: number; representation: 'file_text' | 'normalized' }>;
  attachments: Array<{ sourceId: string; fileIds: string[] }>;
  notes: string[];
}
export type MemoryImportSummary = Omit<MemoryImportDataset, 'files' | 'segments' | 'attachments'> & { fileCount: number; recallEnabled: boolean };
export interface MemoryImportPolicy { enabledScopes: import('./longMemory').LongMemoryScope[] }
