import type { ToolContext } from '../types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import type { LockHolder } from '../../core/fileWriteLockManager';

export interface FileLocation { fsPath: string; scheme: string }
export interface FileWorkspace { name: string; uri: FileLocation }
export interface FileDiscoveryOptions { includeIgnored?: boolean }
export interface SearchFileHost {
  /** 当前宿主是否在配置 glob 之外应用项目 .gitignore。 */
  readonly gitIgnoreSupported?: boolean;
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
  findFiles(root: FileLocation, pattern: string, exclude: string, limit: number, options?: FileDiscoveryOptions): Promise<FileLocation[]>;
  /** 搜索按发现顺序流式消费；仅结果与输出预算封顶，不截断待扫描文件。 */
  iterateFiles?(root: FileLocation, pattern: string, exclude: string, limit: number, options?: FileDiscoveryOptions): AsyncIterable<FileLocation>;
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
