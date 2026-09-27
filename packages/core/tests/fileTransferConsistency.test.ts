import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { startHttpServer } from '../../../apps/server/src/transport/http';
import { fixture } from './fixtures';
import type { ReadStream } from 'node:fs';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, http: Awaited<ReturnType<typeof startHttpServer>>;
let url: string, headers: Record<string, string>, target: string;
let handles: Awaited<ReturnType<typeof fs.open>>[];
beforeEach(async () => {
  handles = [];
  f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
  const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'files', name: '传输夹具', directory: f.source, deviceId: 'local' });
  await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
  target = path.join(f.source, 'sample.bin'); await fs.writeFile(target, 'old');
  const token = randomBytes(32).toString('hex'); http = await startHttpServer(app, { token });
  url = `http://127.0.0.1:${http.port}/files/download/files?path=sample.bin`; headers = { Authorization: 'Bearer ' + token };
});
afterEach(async () => { jest.restoreAllMocks(); await http.close(); await Promise.all(handles.map(handle => handle.close())); await app.close(); await f.cleanup(); });

function captureDownloadHandle(smallChunks = false) {
  const nativeOpen = fs.open;
  let finish!: () => void, stream: ReadStream | undefined;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === target) {
      handles.push(handle);
      const close = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); finish(); });
      if (smallChunks) {
        const create = handle.createReadStream.bind(handle);
        jest.spyOn(handle, 'createReadStream').mockImplementation(options => stream = create({ ...options, highWaterMark: 1024 }));
      }
    }
    return handle;
  });
  return { stream: () => stream, closed: async () => {
    let timer!: ReturnType<typeof setTimeout>;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('下载文件句柄未释放')), 2000); })]); }
    finally { clearTimeout(timer); }
  } };
}

test.each([undefined, 'bytes=-4'])('文件信息查询后内容改变，下载长度及范围使用打开后的实际大小（%s）', async range => {
  const download = app.fileActions.download.bind(app.fileActions);
  const replacement = 'replacement-content';
  jest.spyOn(app.fileActions, 'download').mockImplementationOnce(async (...args) => {
    const info = await download(...args); await fs.writeFile(target, replacement); return info;
  });
  const response = await fetch(url, { headers: { ...headers, ...(range ? { Range: range } : {}) } });
  const expected = range ? replacement.slice(-4) : replacement;
  expect(response.status).toBe(range ? 206 : 200);
  expect(await response.text()).toBe(expected);
  expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(expected)));
  if (range) expect(response.headers.get('content-range')).toBe('bytes 15-18/19');
});

test('文件句柄取得大小后路径被更名并替换，正文仍与同一句柄的响应头一致', async () => {
  const original = 'original-descriptor'; await fs.writeFile(target, original);
  const next = path.join(f.source, 'next.bin'); await fs.writeFile(next, 'replacement-must-not-mix');
  const nativeOpen = fs.open;
  let changed = false, handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const opened = await nativeOpen(...args);
    if (args[0] === target) {
      handle = opened; handles.push(opened);
      const stat = opened.stat.bind(opened);
      jest.spyOn(opened, 'stat').mockImplementationOnce(async () => {
        const info = await stat();
        // Windows 不能覆盖仍打开的目标文件；先更名原文件，验证原路径改指新文件的情形。
        await fs.rename(target, path.join(f.source, 'retained.bin')); await fs.rename(next, target);
        changed = true; return info;
      });
    }
    return opened;
  });
  const response = await fetch(url, { headers });
  expect(await response.text()).toBe(original);
  expect(changed).toBe(true);
  expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(original)));
  await new Promise(resolve => setImmediate(resolve));
  expect(handle?.fd).toBe(-1);
  expect(await fs.readFile(target, 'utf8')).toBe('replacement-must-not-mix');
});

test.each(['HEAD', 'empty', 'range'])('不发送正文的 %s 分支也会关闭文件句柄', async kind => {
  if (kind === 'empty') await fs.truncate(target, 0);
  const captured = captureDownloadHandle();
  const response = await fetch(url, { method: kind === 'HEAD' ? 'HEAD' : 'GET', headers: { ...headers, ...(kind === 'range' ? { Range: 'bytes=99-100' } : {}) } });
  expect(response.status).toBe(kind === 'range' ? 416 : 200);
  expect(await response.text()).toBe('');
  await captured.closed();
});

test('客户端中断下载后关闭读取流与文件句柄', async () => {
  const size = 1024 * 1024; await fs.writeFile(target, Buffer.alloc(size, 97));
  const captured = captureDownloadHandle(true), controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal }); controller.abort();
  await expect(response.arrayBuffer()).rejects.toThrow();
  await captured.closed();
  expect(captured.stream()!.bytesRead).toBeLessThan(size);
});

test.each(['GET', 'HEAD'])('准备 %s 下载期间令牌已撤销，发送响应头前返回未授权并释放句柄', async method => {
  const download = app.fileActions.download.bind(app.fileActions), captured = captureDownloadHandle();
  jest.spyOn(app.fileActions, 'download').mockImplementationOnce(async (...args) => {
    const info = await download(...args); await http.rotateToken(randomBytes(32).toString('hex')); return info;
  });
  const response = await fetch(url, { method, headers });
  expect(response.status).toBe(401); await response.arrayBuffer();
  expect(response.headers.get('content-disposition')).toBeNull();
  await captured.closed();
});
