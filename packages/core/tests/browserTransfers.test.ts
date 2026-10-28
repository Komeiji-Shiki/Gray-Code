import { EventEmitter } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { DownloadItem, WebContents } from 'electron';
import type { PlatformApplication } from '../../../apps/server/src/application';
import type { BrowserPage } from '../../../apps/desktop/src/browser/page';
import { BrowserTransfers } from '../../../apps/desktop/src/browser/transfers';
import { fixture } from './fixtures';

class DownloadFixture extends EventEmitter {
  savePath = ''; received = 0;
  getFilename = () => 'fixture.txt';
  getURL = () => 'https://fixture.test/one-use-download';
  getReceivedBytes = () => this.received;
  getTotalBytes = () => 16;
  setSavePath = jest.fn((file: string) => { this.savePath = file; });
  cancel = jest.fn(() => { this.emit('done', {}, 'cancelled'); });
}

describe('browser retained downloads', () => {
  let f: Awaited<ReturnType<typeof fixture>>, transfers: BrowserTransfers;
  let context: ToolContext, page: BrowserPage, write: jest.Mock;
  const contents = { id: 51 } as WebContents;
  beforeEach(async () => {
    f = await fixture();
    const workspace = { id: 'workspace', name: 'Fixture', directory: f.source, deviceId: 'local' };
    context = { actorId: 'owner', runId: 'download-run', conversationId: 'download-chat', toolCallId: 'download-call', workspace,
      signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() } as ToolContext;
    write = jest.fn(async (_context, changes) => {
      expect(changes[0].bytes).toBeUndefined();
      expect(await readFile(changes[0].sourceFile, 'utf8')).toBe('fixture download');
    });
    const application = { storage: f.store, publish: jest.fn(), changes: { write },
      product: { runtimeSettings: () => ({ isMemoryEnabled: () => false, getWriteFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) },
      files: { resolve: async (_workspace, file) => path.resolve(f.source, file), resolveAbsolute: async file => file,
        transaction: async (_workspace, operation) => operation({ capture: async () => ({ bytes: null, hash: null }) }) },
    } as unknown as PlatformApplication;
    transfers = new BrowserTransfers(application);
    page = { contents, action: jest.fn() } as unknown as BrowserPage;
  });
  afterEach(async () => { await transfers.dispose(); await f.cleanup(); });

  test('普通点击的原始下载跨轮保存，重复回执不再次点击或写入', async () => {
    const previousRun = new AbortController(); const item = new DownloadFixture();
    expect(transfers.receive(contents, item as unknown as DownloadItem, { retain: true, signal: previousRun.signal })).toBe(true);
    await writeFile(item.savePath, 'fixture download'); item.received = 16; item.emit('done', {}, 'completed');
    const downloadId = transfers.list(contents.id)[0].downloadId;
    previousRun.abort();
    expect(transfers.list(contents.id)).toMatchObject([{ downloadId, status: 'completed' }]);
    const args = { path: 'saved.txt', expectedHash: null, downloadId };
    const result = await transfers.download(page, args, context);
    expect(result).toMatchObject({ path: 'saved.txt', bytes: 16, filename: 'fixture.txt', downloadId });
    expect(await transfers.download(page, args, context)).toEqual(result);
    expect(page.action).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
    expect(transfers.list(contents.id)[0].status).toBe('saved');
    await expect(stat(path.dirname(item.savePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('显式 ref 下载仅派发一次点击，等待中取消会停止原请求并清理临时目录', async () => {
    const controller = new AbortController(); context.signal = controller.signal;
    const item = new DownloadFixture(); const click = jest.fn(async () => {
      expect(transfers.receive(contents, item as unknown as DownloadItem)).toBe(true);
      await writeFile(item.savePath, 'partial');
      controller.abort();
    });
    await expect(transfers.download(page, { path: 'saved.txt', expectedHash: null, ref: 'download-link' }, context, click)).rejects.toThrow('下载已停止');
    expect(click).toHaveBeenCalledTimes(1); expect(page.action).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(item.cancel).toHaveBeenCalledTimes(1); expect(transfers.list(contents.id)).toEqual([]);
    await expect(stat(path.dirname(item.savePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('过期任务的下载不接收，关闭标签清理已完成但未保存的文件', async () => {
    const aborted = new AbortController(); aborted.abort(); const stale = new DownloadFixture();
    expect(transfers.receive(contents, stale as unknown as DownloadItem, { retain: true, signal: aborted.signal })).toBe(false);
    expect(stale.setSavePath).not.toHaveBeenCalled();
    const item = new DownloadFixture(); transfers.receive(contents, item as unknown as DownloadItem, { retain: true });
    await writeFile(item.savePath, 'fixture download'); item.emit('done', {}, 'completed');
    await transfers.cancel(contents.id);
    expect(transfers.list(contents.id)).toEqual([]);
    await expect(stat(path.dirname(item.savePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
