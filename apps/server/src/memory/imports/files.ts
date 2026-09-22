import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformStorage } from '@graycode/core';
import { MEMORY_IMPORT_FILE_NAMESPACE, type MemoryImportFile } from '@graycode/contracts';

export const IMPORT_CHUNK_BYTES = 1024 * 1024;
const mimeTypes: Record<string, string> = { '.md': 'text/markdown', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const importHash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export interface SourceFile extends MemoryImportFile { absolute: string }
export async function inspectImportFile(absolute: string, filePath: string, signal?: AbortSignal): Promise<SourceFile> {
  const before = await fs.stat(absolute), hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute, { highWaterMark: IMPORT_CHUNK_BYTES, signal })) hash.update(chunk);
  const after = await fs.stat(absolute);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`读取期间文件发生变化：${filePath}`);
  return { id: importHash(filePath), path: filePath, absolute, bytes: before.size, sha256: hash.digest('hex'),
    mimeType: mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream', chunks: Math.ceil(before.size / IMPORT_CHUNK_BYTES),
    modifiedAt: before.mtime.toISOString(), createdAt: before.birthtime.toISOString() };
}

/** 只读取选定目录，不跟随符号链接；保留全部文件而不是只挑选能解析的正文。 */
export async function inspectImportFiles(directory: string, signal?: AbortSignal): Promise<SourceFile[]> {
  const root = await fs.realpath(directory), files: SourceFile[] = [];
  async function visit(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted(); const name = path.join(relative, entry.name), absolute = path.join(root, name);
      if (entry.isSymbolicLink()) throw new Error(`导入目录包含链接，请先整理成独立文件：${name}`);
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error(`不能导入此类文件：${name}`);
      const filePath = name.replaceAll('\\', '/');
      files.push(await inspectImportFile(absolute, filePath, signal));
    }
  }
  await visit(''); return files;
}

export async function storeImportFile(storage: PlatformStorage, datasetId: string, file: SourceFile, existing: Set<string>, signal?: AbortSignal) {
  const hash = createHash('sha256'); let index = 0, bytes = 0;
  const handle = await fs.open(file.absolute, 'r');
  try { while (bytes < file.bytes) {
    signal?.throwIfAborted();
    const data = new Uint8Array(Math.min(IMPORT_CHUNK_BYTES, file.bytes - bytes)); let filled = 0;
    // 文件系统短读不改变块边界，前端可以按固定大小逐块下载。
    while (filled < data.byteLength) {
      const read = await handle.read(data, filled, data.byteLength - filled, bytes + filled);
      if (!read.bytesRead) throw new Error(`导入期间文件长度变短：${file.path}`);
      filled += read.bytesRead;
    }
    const id = `${datasetId}/${file.id}/${index++}`;
    hash.update(data); bytes += data.byteLength;
    if (existing.has(id)) {
      const saved = await storage.getRecord(MEMORY_IMPORT_FILE_NAMESPACE, id) as { data: Uint8Array } | null;
      if (!saved?.data || importHash(saved.data) !== importHash(data)) throw new Error('先前导入的文件块与当前来源不一致。');
    } else await storage.commitRecords([{ namespace: MEMORY_IMPORT_FILE_NAMESPACE, id, ownerId: datasetId, value: { data }, expectedRevision: null }]);
  }
  if ((await handle.stat()).size !== file.bytes) throw new Error(`导入期间文件长度变化：${file.path}`);
  } finally { await handle.close(); }
  if (index !== file.chunks || bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`导入期间文件发生变化：${file.path}`);
}

/** 逐块重建校验值，不把大型图谱或索引一次加载到主进程。 */
export async function verifyImportFiles(storage: PlatformStorage, datasetId: string, files: MemoryImportFile[], signal?: AbortSignal) {
  let totalBytes = 0;
  for (const file of files) {
    const hash = createHash('sha256'); let bytes = 0;
    for (let index = 0; index < file.chunks; index++) {
      signal?.throwIfAborted(); const data = await readImportFileChunk(storage, datasetId, file, index);
      hash.update(data); bytes += data.byteLength;
    }
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`已存档文件校验失败：${file.path}`);
    totalBytes += bytes;
  }
  return { files: files.length, bytes: totalBytes, verified: true as const };
}

export async function readImportFileChunk(storage: PlatformStorage, datasetId: string, file: MemoryImportFile, index: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunks) throw new Error('文件块序号无效。');
  const value = await storage.getRecord(MEMORY_IMPORT_FILE_NAMESPACE, `${datasetId}/${file.id}/${index}`) as { data: Uint8Array } | null;
  if (!value?.data) throw new Error('原始文件块缺失，请从备份恢复。');
  return value.data;
}
