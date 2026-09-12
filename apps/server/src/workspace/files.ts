import { inside, resolveWorkspacePath, workspaceFilePath, workspaceRootFor, workspaceRoots } from './paths';
export { inside } from './paths';
import type { ToolContext } from '@graycode/core';
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readdir,
  realpath,
  open,
  stat,
  mkdir,
  rmdir,
} from "node:fs/promises";
import type {
  DirectoryEntry,
  DocumentState,
  WorkspaceDefinition,
} from "@graycode/contracts";
import { readFileVersion, replaceFileVersion, type FileTransaction } from './fileTransaction';

const textLimit = 2 * 1024 * 1024;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface DocumentReset {
  workspaceId: string; path: string; clientId: string; previousVersion: number; previousText: string;
  document?: DocumentState; error?: string;
  removed?: boolean;
}
export class WorkspaceFiles {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly documents = new Map<string, DocumentState>();
  private readonly activeEditors = new Map<string, string>();
  private recoveryError?: string;
  constructor(
    private readonly changed: (
      workspaceId: string,
      file: string,
      absolute?: string,
    ) => void = () => {},
    private readonly documentReset: (value: DocumentReset) => void = () => {},
  ) {}

  /** 设置发布时保留文档所指向的文件，只更新其显示路径；移出的目录仍保留草稿供复制。 */
  rebindWorkspaces(previous: readonly WorkspaceDefinition[], next: readonly WorkspaceDefinition[]): void {
    let version = Math.max(0, ...[...this.documents.values()].map(document => document.version)) + 1;
    for (const document of this.documents.values()) {
      const before = previous.find(item => item.id === document.workspaceId);
      const after = next.find(item => item.id === document.workspaceId);
      if (!before || JSON.stringify(before) === JSON.stringify(after)) continue;
      const absolute = resolveWorkspacePath(before, document.path);
      const file = after ? workspaceFilePath(after, absolute) : absolute;
      if (file === document.path) continue;
      const event: DocumentReset = { workspaceId: document.workspaceId, clientId: document.clientId, path: document.path,
        previousVersion: document.version, previousText: document.text };
      document.path = file; document.version = version++;
      event.document = structuredClone(document); this.documentReset(event);
    }
  }

  documentVersion(clientId: string, workspaceId: string, file: string): number | undefined {
    return [...this.documents.values()].find(document => document.clientId === clientId && document.workspaceId === workspaceId && document.path === file)?.version;
  }

  clientDocuments(clientId: string, workspaceId: string): DocumentState[] {
    return [...this.documents.values()].filter(document => document.clientId === clientId && document.workspaceId === workspaceId).map(document => structuredClone(document));
  }

  openPaths(workspaceId?: string): string[] {
    return [...new Set([...this.documents.values()].filter(document => document.workspaceId === workspaceId).map(document => document.path))];
  }

  /** 当前文件属于发起客户端，切换标签不会改变其他客户端的编辑上下文。 */
  focusDocument(clientId: string, workspaceId?: string, file?: string): void {
    if (file === undefined) { this.activeEditors.delete(clientId); return; }
    const entry = [...this.documents].find(([, document]) => document.clientId === clientId && document.workspaceId === workspaceId && document.path === file);
    if (!entry) throw new Error('当前编辑文件尚未在此客户端打开。');
    this.activeEditors.set(clientId, entry[0]);
  }
  editorContext(clientId: string, workspace?: WorkspaceDefinition): { openFiles: string[]; activeFile?: string } {
    if (!workspace) return { openFiles: [] };
    const included = (document: DocumentState) => document.clientId === clientId && document.workspaceId === workspace.id
      && !!workspaceRootFor(workspace, resolveWorkspacePath(workspace, document.path));
    const active = this.documents.get(this.activeEditors.get(clientId) ?? '');
    return { openFiles: [...this.documents.values()].filter(included).map(document => document.path),
      activeFile: active && included(active) ? active.path : undefined };
  }

  blockWrites(reason?: string): void { this.recoveryError = reason; }
  dirtyPaths(workspaceId: string): string[] {
    return [...new Set([...this.documents.values()].filter(document => document.workspaceId === workspaceId && document.dirty).map(document => document.path))];
  }
  private documentInside(key: string, document: DocumentState, directory: string): boolean {
    return inside(this.key(path.resolve(directory)), key.slice(document.clientId.length + 1));
  }
  dirtyPathsInDirectory(directory: string): string[] {
    return [...new Set([...this.documents].filter(([key, document]) => document.dirty && this.documentInside(key, document, directory)).map(([, document]) => document.path))];
  }
  /** 同步 Git 或外部操作改动的干净文件，保持原有草稿版本协议。 */
  async reloadCleanDocuments(directory: string): Promise<void> {
    for (const [key, previous] of this.documents) {
      if (previous.dirty || !this.documentInside(key, previous, directory)) continue;
      const event: DocumentReset = { workspaceId: previous.workspaceId, path: previous.path, clientId: previous.clientId,
        previousVersion: previous.version, previousText: previous.text };
      const current = () => this.documents.get(key) === previous && !previous.dirty && previous.version === event.previousVersion;
      try {
        const value = await this.readAbsolute(key.slice(previous.clientId.length + 1));
        // Git 刷新也会读取外部修改；读取期间输入发生变化时，保留新草稿。
        if (!current()) continue;
        if (value.hash === previous.baseHash) continue;
        if (value.hash === null) { this.documents.delete(key); event.removed = true; }
        else {
          const document = { ...previous, text: value.text, baseHash: value.hash, version: previous.version + 1 };
          this.documents.set(key, document); event.document = structuredClone(document);
        }
      } catch (error) { if (!current()) continue; this.documents.delete(key); event.error = `文件已经变化，无法继续以文本显示：${String(error)}`; }
      this.documentReset(event);
    }
  }
  async resolveAbsolute(file: string, entryOnly = false): Promise<string> {
    const absolute = path.resolve(file);
    let ancestor = entryOnly ? path.dirname(absolute) : absolute;
    for (;;) {
      try { const canonical = await realpath(ancestor); return path.join(canonical, path.relative(ancestor, absolute)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error; ancestor = path.dirname(ancestor); }
    }
  }
  async resolveGranted(workspace: WorkspaceDefinition, file: string, grants: ToolContext['fileWriteGrants'] = [], entryOnly = false, directory = false): Promise<string> {
    const absolute = await this.resolveAbsolute(resolveWorkspacePath(workspace, file), entryOnly);
    const roots = await Promise.all(workspaceRoots(workspace).map(root => realpath(root.directory)));
    if (roots.some(root => inside(root, absolute)) || grants.some(grant => absolute === grant.path || grant.recursive && inside(grant.path, absolute) || directory && inside(absolute, grant.path))) return absolute;
    throw new Error('路径不在本次批准的写入范围内。');
  }
  async resolveEntry(workspace: WorkspaceDefinition, file: string): Promise<string> {
    const absolute = resolveWorkspacePath(workspace, file);
    if (workspaceRoots(workspace).some(root => path.relative(root.directory, absolute) === '')) return this.resolve(workspace, absolute);
    const parent = await this.resolve(workspace, path.dirname(absolute));
    return path.join(parent, path.basename(absolute));
  }

  /** 所有宿主写入和草稿更新共用写锁，恢复期间不会插入另一次保存。 */
  async transaction<T>(workspace: WorkspaceDefinition, operation: (transaction: FileTransaction) => Promise<T>, options: {
    clientId?: string; recovery?: boolean; writeGrants?: ToolContext['fileWriteGrants'];
    rejectDirty?: boolean; discardDirtyFiles?: readonly string[]; dirtyDirectory?: string;
  } = {}): Promise<T> {
    return this.locked('workspace-mutations', async () => {
      if (this.recoveryError && !options.recovery) throw new Error(`WORKSPACE_RECOVERY_REQUIRED: ${this.recoveryError}`);
      const dirty = options.rejectDirty || options.discardDirtyFiles !== undefined
        ? [...this.documents.entries()].filter(([key, document]) => document.dirty &&
          (options.dirtyDirectory ? this.documentInside(key, document, options.dirtyDirectory) : document.workspaceId === workspace.id)) : [];
      const dirtyFiles = [...new Set(dirty.map(([, document]) => document.path))].sort();
      const confirmed = options.discardDirtyFiles !== undefined;
      if (confirmed && JSON.stringify([...new Set(options.discardDirtyFiles)].sort()) !== JSON.stringify(dirtyFiles)) {
        throw Object.assign(new Error('未保存文件已变化，请重新确认。'), { code: 'STALE_DIRTY_CONFIRMATION', dirtyFiles });
      }
      if (!confirmed && options.rejectDirty && dirtyFiles.length) {
        throw Object.assign(new Error('请先确认是否放弃这些文件的未保存修改。'), { code: 'DOCUMENT_DIRTY', dirtyFiles });
      }
      // 确认只允许此次恢复读取磁盘，草稿仍保留；失败时不需要重建被提前删除的内容。
      const ignoredDrafts = new Set(confirmed ? dirty.map(([key]) => key) : []);
      const resolve = (file: string, entryOnly = false, directory = false) => this.resolveGranted(workspace, file, options.writeGrants, entryOnly, directory);
      const capture = async (file: string, entryOnly = false) => {
        const absolute = await resolve(file, entryOnly);
        this.checkDrafts(absolute, options.clientId, ignoredDrafts);
        return readFileVersion(absolute);
      };
      const directoryExists = async (directory: string) => {
        try {
          if (!(await stat(await resolve(directory, false, true))).isDirectory()) throw new Error('目录路径已被文件占用。');
          return true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      };
      const result = await operation({ capture, directoryExists, applyDirectories: async changes => {
        for (const change of changes) if (await directoryExists(change.path) !== change.before) throw new Error(`FILE_CONFLICT: 目录 ${change.path} 已变化。`);
        for (const change of changes) {
          if (change.before === change.after) continue;
          const absolute = await resolve(change.path, false, true);
          if ((await Promise.all(workspaceRoots(workspace).map(root => realpath(root.directory)))).some(root => path.relative(root, absolute) === '')) throw new Error('不能删除工作区根目录。');
          if (change.after) await mkdir(absolute, { recursive: true });
          else await rmdir(absolute);
          this.changed(workspace.id, change.path, absolute);
        }
      }, apply: async changes => {
        const seen = new Set<string>();
        // 整批预检通过后才动文件；操作日志负责处理中途失败和重启恢复。
        for (const change of changes) {
          const absolute = await resolve(change.path, change.entryOnly);
          const key = this.key(absolute);
          if (seen.has(key)) throw new Error('同一批次不能重复修改同一个文件。');
          seen.add(key);
          if ((await capture(change.path, change.entryOnly)).hash !== change.before.hash) throw new Error(`FILE_CONFLICT: ${change.path} 已被修改，请重新读取。`);
        }
        for (const change of changes) {
          const absolute = await resolve(change.path, change.entryOnly);
          if ((await capture(change.path, change.entryOnly)).hash !== change.before.hash) throw new Error(`FILE_CONFLICT: ${change.path} 已被修改。`);
          if (change.before.hash === change.after.hash) continue;
          await replaceFileVersion(absolute, change.after);
          this.changed(workspace.id, change.path, absolute);
        }
      } });
      // 事务成功后才刷新已确认的草稿；写锁会阻止其间插入新一轮编辑。
      if (confirmed) for (const [key, previous] of dirty) {
        if (this.documents.get(key) !== previous) continue;
        const event: DocumentReset = { workspaceId: workspace.id, path: previous.path, clientId: previous.clientId,
          previousVersion: previous.version, previousText: previous.text };
        try {
          const value = await this.read(workspace, previous.path);
          const document: DocumentState = { ...previous, text: value.text, baseHash: value.hash, version: previous.version + 1, dirty: false };
          this.documents.set(key, document); event.document = structuredClone(document);
        } catch (error) {
          this.documents.delete(key);
          event.error = `文件已恢复，但当前内容无法继续以文本显示：${String(error)}`;
        }
        this.documentReset(event);
      }
      return result;
    });
  }

  async resolve(workspace: WorkspaceDefinition, file: string): Promise<string> {
    const absolute = resolveWorkspacePath(workspace, file);
    if (!workspaceRootFor(workspace, absolute)) throw new Error('Path is outside the authorized workspace.');
    const roots = await Promise.all(workspaceRoots(workspace).map(root => realpath(root.directory)));
    const canonical = await this.resolveAbsolute(absolute);
    if (!roots.some(root => inside(root, canonical))) throw new Error('Symlink target is outside the authorized workspace.');
    return canonical;
  }

  async list(
    workspace: WorkspaceDefinition,
    directory = ".",
  ): Promise<DirectoryEntry[]> {
    if (workspaceRoots(workspace).length > 1 && (!directory || directory === '.'))
      return workspaceRoots(workspace).map(root => ({ name: root.name, path: '@' + root.name, kind: 'directory' as const }));
    const absolute = await this.resolve(workspace, directory);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries
      .map((entry) => ({
        name: entry.name,
        path: workspaceFilePath(workspace, path.join(absolute, entry.name)),
        kind: entry.isSymbolicLink()
          ? ("symlink" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
      }))
      .sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.name.localeCompare(b.name),
      );
  }
  private async readAbsolute(
    absolute: string,
  ): Promise<{ text: string; hash: string | null }> {
    try {
      const handle = await open(absolute, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > textLimit)
          throw new Error("Choose a text file smaller than 2 MiB.");
        const bytes = await handle.readFile();
        if (bytes.includes(0))
          throw new Error("Binary files cannot be edited as text.");
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        return { text, hash: digest(text) };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { text: "", hash: null };
      throw error;
    }
  }
  async read(workspace: WorkspaceDefinition, file: string) {
    return this.readAbsolute(await this.resolve(workspace, file));
  }
  private key(absolute: string): string {
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }
  private async locked<T>(
    absolute: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(absolute);
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key);
    }
  }
  private documentKey(clientId: string, absolute: string): string {
    return `${clientId}:${this.key(absolute)}`;
  }
  private checkDrafts(absolute: string, exceptClient?: string, ignored = new Set<string>()): void {
    for (const [key, document] of this.documents) {
      if (
        document.dirty &&
        !ignored.has(key) &&
        document.clientId !== exceptClient &&
        key.endsWith(`:${this.key(absolute)}`)
      )
        throw new Error(
          "DOCUMENT_DIRTY: An editor has unsaved changes. Save or discard them before another writer changes this file.",
        );
    }
  }
  /** 调用者在文件事务内使用；目录操作同时保护所有客户端的子文件草稿。 */
  assertCleanEntries(absolute: string, workspaces: readonly WorkspaceDefinition[]): void {
    for (const [key, document] of this.documents) {
      const file = key.slice(document.clientId.length + 1);
      const workspace = workspaces.find(item => item.id === document.workspaceId);
      const declared = workspace && resolveWorkspacePath(workspace, document.path);
      if (document.dirty && (inside(this.key(absolute), file) || declared && inside(absolute, declared))) throw new Error(`DOCUMENT_DIRTY: ${document.path} 有未保存内容，请先保存或关闭该编辑草稿。`);
    }
  }
  async relocateDocuments(from: string, to: string | undefined, workspaces: readonly WorkspaceDefinition[]): Promise<void> {
    for (const [key, previous] of [...this.documents]) {
      const absolute = key.slice(previous.clientId.length + 1);
      const workspace = workspaces.find(item => item.id === previous.workspaceId);
      const declared = workspace && resolveWorkspacePath(workspace, previous.path);
      const declaredMoved = !!declared && inside(from, declared);
      if (!declaredMoved && !inside(this.key(from), absolute)) continue;
      const target = to && path.join(to, path.relative(declaredMoved ? from : this.key(from), declaredMoved ? declared! : absolute));
      const event: DocumentReset = { workspaceId: previous.workspaceId, path: previous.path, clientId: previous.clientId,
        previousVersion: previous.version, previousText: previous.text, removed: true,
        error: to ? '文件已移动，新的输入仍保留，请另存或复制保存。' : '文件已删除，新的输入仍保留，请另存或复制保存。' };
      this.documents.delete(key);
      if (workspace && target && workspaceRootFor(workspace, target)) {
        try {
          const canonical = await this.resolve(workspace, target);
          const file = workspaceFilePath(workspace, declaredMoved ? target : canonical);
          const value = await this.read(workspace, file);
          const document = { ...previous, path: file, text: value.text, baseHash: value.hash, version: previous.version + 1, dirty: false };
          const nextKey = this.documentKey(previous.clientId, canonical);
          this.documents.set(nextKey, document);
          if (this.activeEditors.get(previous.clientId) === key) this.activeEditors.set(previous.clientId, nextKey);
          event.document = structuredClone(document); event.removed = false;
        } catch (error) { event.error = `文件已移动，但当前内容无法继续以文本显示：${String(error)}`; }
      }
      if (event.removed && this.activeEditors.get(previous.clientId) === key) this.activeEditors.delete(previous.clientId);
      this.documentReset(event);
    }
  }
  async write(
    workspace: WorkspaceDefinition,
    file: string,
    text: string,
    expectedHash: string | null,
    clientId?: string,
  ): Promise<{ hash: string }> {
    if (typeof text !== "string" || Buffer.byteLength(text) > textLimit)
      throw new Error("Text exceeds the 2 MiB editing limit.");
    return this.transaction(workspace, async transaction => {
      const before = await transaction.capture(file);
      if (before.hash !== expectedHash) throw new Error('FILE_CONFLICT: 文件已变化，请重新读取。');
      const bytes = Buffer.from(text);
      const hash = digest(text);
      await transaction.apply([{ path: file, before, after: { bytes, hash, mode: before.mode } }]);
      return { hash };
    }, { clientId });
  }
  async delete(workspace: WorkspaceDefinition, file: string, expectedHash: string): Promise<void> {
    await this.transaction(workspace, async transaction => {
      const before = await transaction.capture(file);
      if (before.hash === null || before.hash !== expectedHash) throw new Error('FILE_CONFLICT: 删除前请重新读取文件。');
      await transaction.apply([{ path: file, before, after: { bytes: null, hash: null } }]);
    });
  }
  async openDocument(
    workspace: WorkspaceDefinition,
    file: string,
    clientId: string,
  ): Promise<DocumentState> {
    const absolute = await this.resolve(workspace, file);
    const key = this.documentKey(clientId, absolute);
    const existing = this.documents.get(key);
    if (existing) return structuredClone(existing);
    const value = await this.readAbsolute(absolute);
    const document: DocumentState = {
      workspaceId: workspace.id,
      path: workspaceFilePath(workspace, absolute),
      text: value.text,
      baseHash: value.hash,
      version: 1,
      dirty: false,
      clientId,
    };
    this.documents.set(key, document);
    return structuredClone(document);
  }
  async updateDocument(
    workspace: WorkspaceDefinition,
    file: string,
    clientId: string,
    text: string,
    version: number,
  ): Promise<DocumentState> {
    return this.locked('workspace-mutations', async () => {
    const absolute = await this.resolve(workspace, file);
    const document = this.documents.get(this.documentKey(clientId, absolute));
    if (!document || document.version !== version)
      throw new Error("DOCUMENT_CONFLICT: Editor draft is stale.");
    if (typeof text !== "string" || Buffer.byteLength(text) > textLimit)
      throw new Error("Text exceeds the editing limit.");
    document.text = text;
    document.version++;
    document.dirty = digest(text) !== document.baseHash;
    return structuredClone(document);
    });
  }

  async saveDocument(
    workspace: WorkspaceDefinition,
    file: string,
    clientId: string,
    version: number,
  ): Promise<DocumentState> {
    const key = this.documentKey(clientId, await this.resolve(workspace, file));
    const document = this.documents.get(key);
    if (!document || document.version !== version)
      throw new Error("DOCUMENT_CONFLICT: Editor draft is stale.");
    const text = document.text;
    const result = await this.write(
      workspace,
      file,
      text,
      document.baseHash,
      clientId,
    );
    document.baseHash = result.hash;
    document.dirty = document.text !== text;
    return structuredClone(document);
  }
  async closeDocument(
    workspace: Pick<WorkspaceDefinition, 'id'>,
    file: string,
    clientId: string,
    discard = false,
  ): Promise<void> {
    const entry = [...this.documents].find(([, doc]) => doc.workspaceId === workspace.id && doc.clientId === clientId && doc.path === file);
    if (!entry) return;
    if (entry[1].dirty && !discard) throw new Error('Document has unsaved changes.');
    this.documents.delete(entry[0]);
    if (this.activeEditors.get(clientId) === entry[0]) this.activeEditors.delete(clientId);
  }
}
