import type { ToolContext } from '../types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import type { LockHolder } from '../../core/fileWriteLockManager';

export interface FileLocation { fsPath: string; scheme: string }
export interface FileWorkspace { name: string; uri: FileLocation }
export interface SearchFileHost {
  getAllWorkspaces(): FileWorkspace[];
  getWorkspaceRoot(): FileLocation | undefined;
  parseWorkspacePath(file: string): { workspace?: FileWorkspace; relativePath: string; isExplicit: boolean; error?: string };
  resolveFileToolPathWithInfo(file: string): { isOutsideWorkspace: boolean };
  toRelativePath(file: FileLocation, prefix?: boolean): string;
  joinPath(root: FileLocation, file: string): FileLocation;
  file(absolute: string): FileLocation;
  stat(file: FileLocation): Promise<{ size: number; type: number }>;
  readFile(file: FileLocation): Promise<Uint8Array>;
  readHeader?(file: FileLocation, bytes: number): Promise<Uint8Array>;
  findFiles(root: FileLocation, pattern: string, exclude: string, limit: number): Promise<FileLocation[]>;
  countLines(file: FileLocation, relative: string): Promise<number | undefined>;
  findExcludePatterns(): string[] | undefined;
  searchConfig(): Readonly<SearchInFilesToolConfig>;
  checkAccess(tool: string, args: Record<string, unknown> | undefined, context?: ToolContext): string | null;
  review(input: { filePath: string; absolutePath: string; originalContent: string; newContent: string;
    blocks: { index: number; startLine: number; endLine: number }[]; toolId?: string; conversationId?: string;
    abortSignal?: AbortSignal; checkpointReady?: Promise<unknown>; lockHolder?: LockHolder }): Promise<{
      wasAccepted: boolean; wasInterrupted: boolean; diffContentId?: string; autoSaveError?: string; pendingDiffId: string;
    }>;
}
