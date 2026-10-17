import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fstatSync, openSync, promises as fs } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { extractBackupArchive, writeBackupArchive } from '../../../apps/server/src/backups/archive';
import { fixture } from './fixtures';

// yauzl 没有随包声明类型；这里只描述测试使用的公开流和关闭事件。
interface TrackedArchive extends EventEmitter {
  openReadStreamPromise(entry: { fileName: string }): Promise<Readable>;
  close(): void;
}

test.each([
  { encrypted: false, failure: 'directory' },
  { encrypted: true, failure: 'directory' },
  { encrypted: false, failure: 'abort' },
  { encrypted: true, failure: 'abort' },
])('归档 encrypted=$encrypted 在 $failure 失败后关闭实际文件句柄', async ({ encrypted, failure }) => {
  const f = await fixture();
  try {
    const input = path.join(f.root, 'input');
    await fs.mkdir(input);
    // 这里只测试归档字节传输；足够大的不可压缩条目不会在消费前自行读到末尾。
    await fs.writeFile(path.join(input, 'platform.sqlite'), randomBytes(512 * 1024));
    const filename = path.join(f.root, 'archive.graycode-backup');
    const password = encrypted ? 'fixture-password' : undefined;
    await writeBackupArchive({ directory: input, destination: filename, password, signal: new AbortController().signal,
      progress() {}, manifest: { format: 'graycode-backup', version: 1, createdAt: Date.now(), appVersion: 'fixture',
        schemaVersion: 1, sourceDirectory: input, credentials: encrypted ? 'password' : 'device', conversations: 0, messages: 0, exclusions: [] } });
    const output = path.join(f.root, 'output');
    if (failure === 'directory') await fs.writeFile(output, '这个路径是文件，不能创建目录');
    const controller = new AbortController();
    const fd = openSync(filename, 'r');
    const archive: TrackedArchive = await yauzl.fromFdPromise(fd, { autoClose: false, strictFileNames: true });
    let archiveClosed = false;
    const closed = new Promise<void>(resolve => archive.once('close', () => { archiveClosed = true; resolve(); }));
    const streams: Readable[] = [];
    const originalRead = archive.openReadStreamPromise.bind(archive);
    const track = jest.spyOn(archive, 'openReadStreamPromise').mockImplementation(async entry => {
      const stream = await originalRead(entry);
      streams.push(stream);
      if (failure === 'abort' && entry.fileName === 'data/platform.sqlite') controller.abort();
      return stream;
    });
    const opening = jest.spyOn(yauzl, 'openPromise').mockResolvedValue(archive);
    try {
      await expect(extractBackupArchive({ source: filename, directory: output, password, signal: controller.signal, progress() {} }))
        .rejects.toMatchObject(failure === 'directory' ? { code: 'EEXIST' } : { name: 'AbortError' });
      const deadline = Date.now() + 1500;
      while (!archiveClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
      expect(archiveClosed).toBe(true);
    } finally {
      opening.mockRestore();
      track.mockRestore();
      for (const stream of streams) stream.destroy();
      archive.close();
      await closed;
    }
  } finally { await f.cleanup(); }
});
