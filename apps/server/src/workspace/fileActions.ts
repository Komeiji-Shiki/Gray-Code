import { workspaceFilePath, workspaceRootFor, workspaceRoots } from './paths';
import { createHash } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { UI_FILE_UPLOAD_LIMIT, type FileEntryInfo, type WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { inside } from './files';
import { fileHash } from './fileTransaction';

const mediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8' };

export class WorkspaceFileActions {
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly app: PlatformApplication) {}
  get hasPending() { return this.pending.size > 0; }
  private track<T>(actorId: string, operation: () => Promise<T>): Promise<T> {
    this.app.requireOwner(actorId);
    if (this.closing) return Promise.reject(new Error('核心正在关闭，请稍后重新连接。'));
    const work = operation(); this.pending.add(work); this.app.publish({ type: 'file.activity', pending: this.pending.size });
    return work.finally(() => { this.pending.delete(work); this.app.publish({ type: 'file.activity', pending: this.pending.size }); });
  }
  async close(): Promise<void> { this.closing = true; while (this.pending.size) await Promise.allSettled([...this.pending]); }
  private workspace(actorId: string, workspaceId: string, write = false, deletion = false) {
    this.app.requireOwner(actorId);
    return this.app.workspace(actorId, workspaceId, write ? ['workspace_write', ...(deletion ? ['data_delete' as const] : [])] : ['workspace_read']);
  }
  private async entry(workspace: WorkspaceDefinition, file: string): Promise<FileEntryInfo & { absolute: string }> {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw new Error('请选择有效的文件路径。');
    const absolute = await this.app.files.resolveEntry(workspace, file);
    const relative = workspaceFilePath(workspace, absolute);
    try {
      const info = await lstat(absolute, { bigint: true });
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) throw new Error('暂不支持操作这个特殊文件。');
      const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
      const version = createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, kind].join(':')).digest('hex');
      return { absolute, path: relative, name: path.basename(absolute), kind, size: Number(info.size), modifiedAt: Number(info.mtimeMs), version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { absolute, path: relative, name: path.basename(absolute), kind: 'missing', size: 0, modifiedAt: 0, version: 'missing' };
    }
  }
  async inspect(actorId: string, workspaceId: string, file: string): Promise<FileEntryInfo> {
    const { absolute: _absolute, ...entry } = await this.entry(this.workspace(actorId, workspaceId), file); return entry;
  }
  private mutable(workspace: WorkspaceDefinition, absolute: string) {
    if (!workspaceRootFor(workspace, absolute) || workspaceRoots(workspace).some(root => path.relative(root.directory, absolute) === '')) throw new Error('不能修改工作区根目录。');
    for (const root of this.app.settings.snapshot().settings.workspaces.flatMap(item => [...workspaceRoots(item)]))
      if (inside(absolute, root.directory)) throw new Error('该目录包含已登记的工作区，请先从工作区列表移除后再操作。');
  }
  private expect(entry: FileEntryInfo, version: unknown) {
    if (typeof version !== 'string' || entry.version !== version) throw new Error('FILE_CONFLICT: 目录项已变化，请刷新后重新确认。');
  }
  private changed(workspace: WorkspaceDefinition, kind: string, from: string, to?: string) {
    this.app.publish({ type: 'workspace.entry.changed', workspaceId: workspace.id, kind, from, to });
  }
  create(actorId: string, workspaceId: string, file: string, kind: 'file' | 'directory'): Promise<FileEntryInfo> {
    return this.track(actorId, () => this.createEntry(actorId, workspaceId, file, kind));
  }
  private async createEntry(actorId: string, workspaceId: string, file: string, kind: 'file' | 'directory'): Promise<FileEntryInfo> {
    const workspace = this.workspace(actorId, workspaceId, true);
    if (!['file', 'directory'].includes(kind)) throw new Error('请选择新建文件或目录。');
    if (kind === 'file') await this.app.files.write(workspace, file, '', null);
    else await this.app.files.transaction(workspace, async () => {
      const target = await this.entry(workspace, file); this.mutable(workspace, target.absolute);
      if (target.kind !== 'missing') throw new Error('FILE_CONFLICT: 该路径已存在。');
      this.app.files.assertCleanEntries(target.absolute, this.app.settings.snapshot().settings.workspaces);
      await mkdir(target.absolute, { recursive: true });
    });
    const entry = await this.inspect(actorId, workspaceId, file); this.changed(workspace, 'create', entry.path); return entry;
  }
  move(actorId: string, workspaceId: string, file: string, target: string, expectedVersion: string): Promise<FileEntryInfo> {
    return this.track(actorId, () => this.moveEntry(actorId, workspaceId, file, target, expectedVersion));
  }
  private async moveEntry(actorId: string, workspaceId: string, file: string, target: string, expectedVersion: string): Promise<FileEntryInfo> {
    const workspace = this.workspace(actorId, workspaceId, true);
    return this.app.files.transaction(workspace, async () => {
      const from = await this.entry(workspace, file); const to = await this.entry(workspace, target);
      this.mutable(workspace, from.absolute); this.mutable(workspace, to.absolute); this.expect(from, expectedVersion);
      if (from.kind === 'missing') throw new Error('要移动的目录项已经不存在。');
      if (from.absolute === to.absolute) return this.inspect(actorId, workspaceId, file);
      const caseOnly = process.platform === 'win32' && from.absolute.toLowerCase() === to.absolute.toLowerCase();
      if (!caseOnly && to.kind !== 'missing') throw new Error('FILE_CONFLICT: 目标路径已存在。');
      if (!caseOnly && from.kind === 'directory' && inside(from.absolute, to.absolute)) throw new Error('不能把目录移动到它自己的子目录。');
      this.app.files.assertCleanEntries(from.absolute, this.app.settings.snapshot().settings.workspaces);
      this.app.files.assertCleanEntries(to.absolute, this.app.settings.snapshot().settings.workspaces);
      // 同一工作区内使用文件系统重命名，移动失败时不改动编辑器记录。
      await rename(from.absolute, to.absolute);
      await this.app.files.relocateDocuments(from.absolute, to.absolute, this.app.settings.snapshot().settings.workspaces);
      this.changed(workspace, 'move', from.path, to.path);
      return this.inspect(actorId, workspaceId, to.path);
    });
  }
  remove(actorId: string, workspaceId: string, file: string, expectedVersion: string, recursive = false): Promise<void> {
    return this.track(actorId, () => this.removeEntry(actorId, workspaceId, file, expectedVersion, recursive));
  }
  private async removeEntry(actorId: string, workspaceId: string, file: string, expectedVersion: string, recursive = false): Promise<void> {
    const workspace = this.workspace(actorId, workspaceId, true, true);
    await this.app.files.transaction(workspace, async () => {
      const entry = await this.entry(workspace, file); this.mutable(workspace, entry.absolute); this.expect(entry, expectedVersion);
      if (entry.kind === 'missing') throw new Error('目录项已经不存在。');
      if (entry.kind === 'directory' && !recursive) throw new Error('请明确确认删除目录及其内容。');
      this.app.files.assertCleanEntries(entry.absolute, this.app.settings.snapshot().settings.workspaces);
      try { await rm(entry.absolute, { recursive: entry.kind === 'directory', force: false }); }
      catch (error) { this.changed(workspace, 'refresh', entry.path); throw new Error(`删除未完成，请刷新检查当前目录：${String(error)}`); }
      await this.app.files.relocateDocuments(entry.absolute, undefined, this.app.settings.snapshot().settings.workspaces);
      this.changed(workspace, 'remove', entry.path);
    });
  }
  upload(actorId: string, workspaceId: string, file: string, expectedVersion: string, bytes: Uint8Array): Promise<FileEntryInfo> {
    return this.track(actorId, () => this.uploadBytes(actorId, workspaceId, file, expectedVersion, bytes));
  }
  private async uploadBytes(actorId: string, workspaceId: string, file: string, expectedVersion: string, bytes: Uint8Array): Promise<FileEntryInfo> {
    const workspace = this.workspace(actorId, workspaceId, true);
    if (!(bytes instanceof Uint8Array) || bytes.length > UI_FILE_UPLOAD_LIMIT) throw new Error('单个上传文件不能超过 64 MiB。');
    await this.app.files.transaction(workspace, async transaction => {
      const entry = await this.entry(workspace, file); this.mutable(workspace, entry.absolute); this.expect(entry, expectedVersion);
      if (!['file', 'missing'].includes(entry.kind)) throw new Error('上传目标必须是普通文件路径。');
      const before = await transaction.capture(entry.path);
      this.expect(await this.entry(workspace, entry.path), expectedVersion);
      await transaction.apply([{ path: entry.path, before, after: { bytes, hash: fileHash(bytes), mode: before.mode } }]);
    });
    const entry = await this.inspect(actorId, workspaceId, file); this.changed(workspace, 'upload', entry.path); return entry;
  }
  async download(actorId: string, workspaceId: string, file: string) {
    const workspace = this.workspace(actorId, workspaceId);
    const absolute = await this.app.files.resolve(workspace, file);
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error('请选择要下载的普通文件。');
    return { absolute, name: path.basename(absolute), size: info.size, mimeType: mediaTypes[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream' };
  }
}
