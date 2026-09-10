import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 复制时计算内容指纹，不执行依赖脚本，也不对来源调用会修复缓存的管理器。 */
export async function captureDirectory(source: string, destination: string | undefined, signal: AbortSignal,
  onProgress?: (progress: { currentItem: string; processedBytes?: number; totalBytes?: number }) => void) {
  const digest = createHash('sha256'); const files: string[] = [];
  const stamps: { file: string; size: number; mtimeMs: number; ino: number }[] = [];
  async function visit(relative: string) {
    signal.throwIfAborted();
    const file = path.join(source, relative); const before = await fs.lstat(file);
    onProgress?.({ currentItem: file });
    if (before.isSymbolicLink()) throw new Error(`目录包含符号链接，原文件保留：${relative}`);
    if (before.isDirectory()) {
      if (destination) await fs.mkdir(path.join(destination, relative), { recursive: true });
      const entries = (await fs.readdir(file)).sort();
      digest.update(JSON.stringify(['directory', relative, entries]));
      if (!entries.length) files.push(file);
      for (const name of entries) await visit(path.join(relative, name));
      if (JSON.stringify((await fs.readdir(file)).sort()) !== JSON.stringify(entries)) throw new Error(`复制期间目录内容发生变化：${relative}`);
    } else if (before.isFile()) {
      const contentHash = createHash('sha256');
      let processedBytes = 0;
      const consume = (chunk: Buffer) => {
        contentHash.update(chunk); processedBytes += chunk.length;
        onProgress?.({ currentItem: file, processedBytes, totalBytes: before.size });
      };
      if (destination) {
        await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, done) {
          consume(chunk); done(null, chunk);
        } }), createWriteStream(path.join(destination, relative), { flags: 'wx', mode: before.mode }), { signal });
        await fs.chmod(path.join(destination, relative), before.mode & 0o777);
      } else {
        for await (const chunk of createReadStream(file, { signal })) consume(chunk);
      }
      const after = await fs.lstat(file);
      if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error(`复制期间文件发生变化：${relative}`);
      digest.update(JSON.stringify(['file', relative, before.mode & 0o777, contentHash.digest('hex')])); files.push(file); stamps.push({ file, size: after.size, mtimeMs: after.mtimeMs, ino: after.ino });
    } else throw new Error(`不是普通文件或目录：${relative}`);
  }
  await visit('');
  for (const stamp of stamps) {
    onProgress?.({ currentItem: stamp.file });
    signal.throwIfAborted(); const current = await fs.lstat(stamp.file);
    if (!current.isFile() || stamp.size !== current.size || stamp.mtimeMs !== current.mtimeMs || stamp.ino !== current.ino) throw new Error(`复制期间文件发生变化：${stamp.file}`);
  }
  return { fingerprint: digest.digest('hex'), files };
}

