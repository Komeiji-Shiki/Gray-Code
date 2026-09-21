import { parseWorkspacePath, resolveWorkspacePath, workspaceFilePath, workspaceRootFor, workspaceRoots } from './paths';
import type { FileReadAccess } from './readAccess';
import path from 'node:path';
import { lstat, open, readFile, readdir, stat } from 'node:fs/promises';
import minimatch from 'minimatch';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { SearchFileHost, FileLocation, FileWorkspace } from '../../../../backend/tools/search/fileHost';
import type { ReadFileHost } from '../../../../backend/tools/file/readFileRuntime';
import type { ListFilesHost } from '../../../../backend/tools/file/listFilesRuntime';
import { isBinaryFile } from '../../../../backend/tools/shared/multimodal';
import { MAX_LINE_COUNT_FILE_BYTES } from '../../../../backend/tools/shared/fileSizeGuards';
import { detectTextFromHeader, decodeTextBytes } from '../../../../backend/tools/search/textEncodingRuntime';

/** 每次调用独享的文件宿主，工作区与账号来自运行器而不是模型自报参数。 */
export class NodeFileHost implements SearchFileHost, ReadFileHost, ListFilesHost {
  constructor(private readonly app: PlatformApplication, private readonly context: ToolContext, private readonly readAccess?: FileReadAccess) {}
  private location(absolute: string): FileLocation { return { fsPath: absolute, scheme: 'file' }; }
  private workspace() {
    if (!this.context.workspace) throw new Error('请先选择工作区。');
    return this.context.workspace;
  }
  getAllWorkspaces(): FileWorkspace[] {
    const workspace = this.context.workspace;
    return workspace ? workspaceRoots(workspace).map(root => ({ name: root.name, uri: this.location(root.directory) })) : [];
  }
  getWorkspaceRoot(): FileLocation | undefined { return this.getAllWorkspaces()[0]?.uri; }
  parseWorkspacePath(file: string) {
    const selected = this.context.workspace;
    if (!selected) return { workspace: undefined, relativePath: file, isExplicit: false, error: '没有已选择的工作区。' };
    const parsed = parseWorkspacePath(selected, file || '.');
    return { ...parsed, workspace: parsed.workspace ? { name: parsed.workspace.name, uri: this.location(parsed.workspace.directory) } : undefined };
  }
  resolveUriWithInfo(file: string) {
    try {
      const absolute = resolveWorkspacePath(this.context.workspace, file);
      const root = this.context.workspace && workspaceRootFor(this.context.workspace, absolute);
      return { uri: this.location(absolute), workspace: root ? { name: root.name } : undefined,
        relativePath: root ? path.relative(root.directory, absolute).replaceAll('\\', '/') : file,
        isExplicit: !!this.context.workspace && workspaceRoots(this.context.workspace).length > 1 };
    } catch (error) { return { relativePath: file, isExplicit: false, error: String(error) }; }
  }
  resolveFileToolPathWithInfo(file: string) {
    const workspace = this.context.workspace;
    return { isOutsideWorkspace: !workspace || !workspaceRootFor(workspace, resolveWorkspacePath(workspace, file)) };
  }
  toRelativePath(file: FileLocation, prefix = false): string {
    return workspaceFilePath(this.workspace(), file.fsPath, prefix);
  }
  joinPath(root: FileLocation, file: string): FileLocation { return this.location(path.resolve(root.fsPath, file)); }
  file(absolute: string): FileLocation { return this.location(absolute); }
  private async safe(file: FileLocation): Promise<string> {
    this.context.signal.throwIfAborted();
    return this.readAccess ? this.readAccess.resolve(file.fsPath) : this.app.files.resolveGranted(this.workspace(), file.fsPath, this.context.fileWriteGrants);
  }
  async stat(file: FileLocation) {
    const value = await stat(await this.safe(file));
    return { size: value.size, type: value.isDirectory() ? 2 : value.isFile() ? 1 : 0 };
  }
  async readFile(file: unknown): Promise<Uint8Array> { return readFile(await this.safe(file as FileLocation)); }
  async readHeader(file: FileLocation, bytes: number): Promise<Uint8Array> {
    const handle = await open(await this.safe(file), 'r');
    try { const buffer = Buffer.alloc(Math.max(0, Math.floor(bytes))); const result = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, result.bytesRead); }
    finally { await handle.close(); }
  }
  async readDirectory(file: FileLocation): Promise<[string, number][]> {
    return (await readdir(await this.safe(file), { withFileTypes: true })).map(entry => [entry.name,
      entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0]);
  }
  async findFiles(root: FileLocation, pattern: string, exclude: string, limit: number): Promise<FileLocation[]> {
    const result: FileLocation[] = [];
    for await (const file of this.iterateFiles(root, pattern, exclude, limit)) result.push(file);
    return result;
  }
  async *iterateFiles(root: FileLocation, pattern: string, exclude: string, limit: number): AsyncGenerator<FileLocation> {
    const directory = await this.safe(root); const pending = [directory]; let found = 0;
    const match = new minimatch.Minimatch(pattern, { dot: true, nocase: process.platform === 'win32' });
    const ignored = new minimatch.Minimatch(exclude || '__graycode_no_exclusions__', { dot: true, nocase: process.platform === 'win32' });
    while (pending.length && found < limit) {
      this.context.signal.throwIfAborted();
      const current = pending.pop()!;
      for (const entry of await readdir(await this.safe(this.location(current)), { withFileTypes: true })) {
        this.context.signal.throwIfAborted();
        const absolute = path.join(current, entry.name); const relative = path.relative(directory, absolute).replaceAll('\\', '/');
        if (entry.isSymbolicLink()) continue;
        if (ignored.match(relative) || (entry.isDirectory() && ignored.match(`${relative}/`))) continue;
        if (entry.isDirectory()) { if (entry.name !== '.git') pending.push(absolute); }
        else if (entry.isFile() && match.match(relative)) { found++; yield this.location(absolute); }
        if (found >= limit) break;
      }
    }
  }
  async countLines(file: FileLocation, relative: string): Promise<number | undefined> {
    if (isBinaryFile(relative)) return undefined;
    try {
      const absolute = await this.safe(file);
      if ((await stat(absolute)).size > MAX_LINE_COUNT_FILE_BYTES) return undefined;
      const handle = await open(absolute, 'r');
      try {
        let lines = 1; const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          this.context.signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) return lines;
          for (let index = 0; index < bytesRead; index++) if (buffer[index] === 10) lines++;
        }
      } finally { await handle.close(); }
    } catch (error) { this.context.signal.throwIfAborted(); return undefined; }
  }
  countTextFileLines(file: FileLocation, relative: string) { return this.countLines(file, relative); }
  findExcludePatterns() { return this.app.product.runtimeSettings().getFindFilesConfig().excludePatterns; }
  ignorePatterns() { return this.app.product.runtimeSettings().getListFilesConfig().ignorePatterns; }
  searchConfig() { return this.app.product.runtimeSettings().getSearchInFilesConfig(); }
  checkAccess() { return null; }
  ensureOutsideWorkspaceAccessApproved() { return null; }
  async review(input: Parameters<SearchFileHost['review']>[0]) {
    const file = input.absolutePath;
    const before = await this.app.files.transaction(this.workspace(), transaction => transaction.capture(file), { writeGrants: this.context.fileWriteGrants });
    if (!before.bytes) throw new Error('FILE_CONFLICT: 文件在生成替换提案后被删除。');
    const encoding = detectTextFromHeader(before.bytes.subarray(0, 4096));
    if (!encoding.isText) throw new Error('不能对二进制文件执行文本替换。');
    const text = decodeTextBytes(before.bytes, encoding);
    if (text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') !== input.originalContent) throw new Error('FILE_CONFLICT: 文件在生成替换提案后发生变化。');
    const result = await this.app.diffs.propose(this.context, file, text, input.newContent, before.hash, encoding);
    return { wasAccepted: result.status === 'accepted', wasInterrupted: result.status === 'cancelled', diffContentId: result.id,
      autoSaveError: result.error, pendingDiffId: result.id };
  }
}
