import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink, symlink, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** 文件快照保留编码、BOM 和二进制内容，hash: null 明确表示文件不存在。 */
export interface FileVersion {
  bytes: Uint8Array | null; hash: string | null; mode?: number; link?: string;
  /** 大文件沿用内容对象保存分块引用，恢复记录不携带整份正文。旧 bytes 快照仍可读取。 */
  chunks?: string[];
}
export interface FileVersionReadOptions {
  saveChunk?: (bytes: Uint8Array) => Promise<string>;
  hashOnly?: boolean;
  signal?: AbortSignal;
}
export type FileChunkReader = (id: string) => Promise<Uint8Array>;
export interface FileChange { path: string; before: FileVersion; after: FileVersion; entryOnly?: boolean }
export interface DirectoryChange { path: string; before: boolean; after: boolean }
export const fileHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function readFileVersion(absolute: string, options: FileVersionReadOptions = {}): Promise<FileVersion> {
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
      if (options.saveChunk || options.hashOnly) {
        const hash = createHash('sha256'); const chunks: string[] = [];
        for await (const bytes of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024, signal: options.signal })) {
          hash.update(bytes);
          if (options.saveChunk) chunks.push(await options.saveChunk(bytes));
        }
        return { bytes: null, hash: hash.digest('hex'), mode: info.mode, ...(options.saveChunk ? { chunks } : {}) };
      }
      const bytes = await handle.readFile();
      return { bytes, hash: fileHash(bytes), mode: info.mode };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, hash: null };
    throw error;
  }
}

/** 调用者必须持有宿主写锁，并在每次变更前重新检查路径和版本。 */
export async function replaceFileVersion(absolute: string, value: FileVersion, readChunk?: FileChunkReader): Promise<void> {
  if (value.link !== undefined) {
    if (value.hash !== fileHash(Buffer.from(`symlink:${value.link}`))) throw new Error('链接快照校验失败。');
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(path.dirname(absolute), `.graycode-${randomUUID()}.tmp`);
    try { await symlink(value.link, temporary); await rename(temporary, absolute); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return;
  }
  if (value.hash === null && value.bytes === null && !value.chunks) { await unlink(absolute); return; }
  if ((value.chunks && !readChunk) || (!value.chunks && value.bytes === null)) throw new Error('文件快照正文缺失。');
  if (!value.chunks && fileHash(value.bytes!) !== value.hash) throw new Error('文件快照校验失败。');
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.graycode-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', value.mode ?? 0o600);
    try {
      if (value.chunks) {
        const hash = createHash('sha256');
        for (const id of value.chunks) {
          const bytes = await readChunk!(id); hash.update(bytes); await handle.writeFile(bytes);
        }
        if (hash.digest('hex') !== value.hash) throw new Error('文件快照校验失败。');
      } else await handle.writeFile(value.bytes!);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, absolute);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export interface FileTransaction {
  capture(file: string, entryOnly?: boolean, options?: FileVersionReadOptions): Promise<FileVersion>;
  apply(changes: FileChange[], readChunk?: FileChunkReader): Promise<void>;
  directoryExists(directory: string): Promise<boolean>;
  applyDirectories(changes: DirectoryChange[]): Promise<void>;
}
