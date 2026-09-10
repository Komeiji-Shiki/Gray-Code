import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink, symlink, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** 字节快照保留编码、BOM 和二进制内容，null 明确表示文件不存在。 */
export interface FileVersion { bytes: Uint8Array | null; hash: string | null; mode?: number; link?: string }
export interface FileChange { path: string; before: FileVersion; after: FileVersion; entryOnly?: boolean }
export interface DirectoryChange { path: string; before: boolean; after: boolean }
export const fileHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function readFileVersion(absolute: string): Promise<FileVersion> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const link = await readlink(absolute);
      return { bytes: null, hash: fileHash(Buffer.from(`symlink:${link}`)), link, mode: info.mode };
    }
    const handle = await open(absolute, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('文件操作目标必须是普通文件。');
      const bytes = await handle.readFile();
      return { bytes, hash: fileHash(bytes), mode: info.mode };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, hash: null };
    throw error;
  }
}

/** 调用者必须持有宿主写锁，并在每次变更前重新检查路径和版本。 */
export async function replaceFileVersion(absolute: string, value: FileVersion): Promise<void> {
  if (value.link !== undefined) {
    if (value.hash !== fileHash(Buffer.from(`symlink:${value.link}`))) throw new Error('链接快照校验失败。');
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(path.dirname(absolute), `.graycode-${randomUUID()}.tmp`);
    try { await symlink(value.link, temporary); await rename(temporary, absolute); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return;
  }
  if (value.bytes === null) { await unlink(absolute); return; }
  if (fileHash(value.bytes) !== value.hash) throw new Error('文件快照校验失败。');
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.graycode-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', value.mode ?? 0o600);
    try { await handle.writeFile(value.bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, absolute);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export interface FileTransaction {
  capture(file: string, entryOnly?: boolean): Promise<FileVersion>;
  apply(changes: FileChange[]): Promise<void>;
  directoryExists(directory: string): Promise<boolean>;
  applyDirectories(changes: DirectoryChange[]): Promise<void>;
}
