import type { DownloadItem, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../server/src/application';
import { FileReadAccess } from '../../../server/src/workspace/readAccess';
import { prepareExternalWrite } from '../../../server/src/workspace/writeAccess';
import type { BrowserPage } from './page';

export interface BrowserDownload {
  downloadId: string; filename: string; url: string;
  status: 'waiting' | 'downloading' | 'completed' | 'failed' | 'saved';
  bytes: number; totalBytes: number; error?: string;
}
interface SavedDownload { path: string; bytes: number; filename: string; url: string; downloadId: string }
interface PendingDownload {
  contentsId: number; directory: string; path: string; maximumBytes: number; info: BrowserDownload;
  item?: DownloadItem; ready: Promise<void>; resolve(): void; reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>; detachAbort?: () => void;
  cleaning?: Promise<void>;
  saved?: { workspaceId: string; expectedHash: string | null; result: SavedDownload };
}
const defaultMaximumBytes = 64 * 1024 * 1024;

/** 原始下载只发起一次，先保留会话、POST 正文与文件，再按下载引用提交工作区事务。 */
export class BrowserTransfers {
  private readonly downloads = new Map<string, PendingDownload>();
  private readonly waiting = new Map<number, PendingDownload>();
  private readonly cleanup = new Set<Promise<void>>();
  constructor(private readonly app: PlatformApplication) {}

  private create(contentsId: number, maximumBytes: number, signal?: AbortSignal): PendingDownload {
    signal?.throwIfAborted();
    // will-download 必须同步指定保存位置，否则 Electron 会弹出系统保存框。
    const directory = mkdtempSync(path.join(this.app.storage.directory, 'browser-transfer-'));
    let resolve!: () => void; let reject!: (error: Error) => void;
    const ready = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    // 普通点击不会等待文件完成；下载失败保存在回执中，不能成为未处理的 Promise 拒绝。
    void ready.catch(() => {});
    const transfer: PendingDownload = { contentsId, directory, path: path.join(directory, 'download'), maximumBytes, ready, resolve, reject,
      info: { downloadId: randomUUID(), filename: '', url: '', status: 'waiting', bytes: 0, totalBytes: 0 } };
    this.downloads.set(transfer.info.downloadId, transfer);
    transfer.timer = setTimeout(() => this.fail(transfer, new Error('下载超时，请在页面确认文件是否仍可下载。')), 120000);
    transfer.timer.unref();
    if (signal) {
      const abort = () => { void this.remove(transfer, new Error('下载已停止。')).catch(error => this.app.publish({ type: 'browser.transfer.failed', error: String(error) })); };
      signal.addEventListener('abort', abort, { once: true });
      transfer.detachAbort = () => signal.removeEventListener('abort', abort);
    }
    return transfer;
  }

  receive(contents: WebContents, item: DownloadItem, options?: { retain: true; signal?: AbortSignal }): boolean {
    let transfer = this.waiting.get(contents.id);
    if (!transfer || transfer.item) {
      if (!options || options.signal?.aborted) return false;
      transfer = this.create(contents.id, defaultMaximumBytes, options.signal);
    }
    const current = transfer;
    current.item = item; current.info.filename = item.getFilename(); current.info.url = item.getURL();
    current.info.status = 'downloading'; item.setSavePath(current.path);
    const update = () => {
      if (current.info.status !== 'downloading') return;
      current.info.bytes = item.getReceivedBytes(); current.info.totalBytes = item.getTotalBytes();
      if (current.info.totalBytes > current.maximumBytes || current.info.bytes > current.maximumBytes)
        this.fail(current, new Error(`下载超过 maxBytes 限额（${current.maximumBytes} 字节）；可显式提高 maxBytes 后通过原 ref 下载。`));
    };
    item.on('updated', update);
    item.once('done', (_event, state) => {
      item.removeListener('updated', update);
      if (current.info.status !== 'downloading') return;
      update();
      if (current.info.status !== 'downloading') return;
      if (state === 'completed') {
        current.info.status = 'completed'; this.clearTimer(current);
        // 完成文件属于活标签，后续轮次仍可保存；任务结束仅取消尚未完成的请求。
        current.detachAbort?.(); current.detachAbort = undefined; current.resolve();
      } else this.fail(current, new Error(`下载未完成：${state}`));
    });
    update();
    return true;
  }

  list(contentsId: number): BrowserDownload[] {
    return [...this.downloads.values()].filter(item => item.contentsId === contentsId).map(item => ({ ...item.info }));
  }

  private clearTimer(transfer: PendingDownload): void {
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = undefined;
    if (this.waiting.get(transfer.contentsId) === transfer) this.waiting.delete(transfer.contentsId);
  }

  private fail(transfer: PendingDownload, error: Error): void {
    if (!['waiting', 'downloading'].includes(transfer.info.status)) return;
    transfer.info.status = 'failed'; transfer.info.error = error.message;
    this.clearTimer(transfer); transfer.reject(error); transfer.item?.cancel();
    void this.cleanFile(transfer);
  }

  private cleanFile(transfer: PendingDownload): Promise<void> {
    if (transfer.cleaning) return transfer.cleaning;
    // 仅清理本实例创建的临时目录；递归删除前检查其绝对路径及直接父目录。
    const directory = path.resolve(transfer.directory);
    if (path.dirname(directory) !== path.resolve(this.app.storage.directory) || !path.basename(directory).startsWith('browser-transfer-'))
      return Promise.reject(new Error('下载临时目录不属于当前宿主。'));
    const cleaning = transfer.cleaning = rm(directory, { recursive: true, force: true });
    this.cleanup.add(cleaning);
    void cleaning.then(() => this.cleanup.delete(cleaning), error => {
      transfer.cleaning = undefined; this.cleanup.delete(cleaning);
      this.app.publish({ type: 'browser.transfer.failed', error: String(error) });
    });
    return cleaning;
  }

  private async remove(transfer: PendingDownload, error = new Error('下载已停止。')): Promise<void> {
    this.downloads.delete(transfer.info.downloadId); transfer.detachAbort?.(); transfer.detachAbort = undefined;
    this.clearTimer(transfer); this.fail(transfer, error);
    await this.cleanFile(transfer);
  }

  async cancel(contentsId: number): Promise<void> {
    await Promise.all([...this.downloads.values()].filter(item => item.contentsId === contentsId).map(item => this.remove(item)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.downloads.values()].map(item => this.remove(item)));
    await Promise.all(this.cleanup);
  }
  async upload(page: BrowserPage, args: Record<string, unknown>, context: ToolContext) {
    if (!Array.isArray(args.paths)) throw Object.assign(new Error('upload 需要 paths 指定文件。'), { code: 'INVALID_ARGUMENTS' });
    const access = new FileReadAccess(this.app, context); const files: string[] = [];
    for (const requested of args.paths as string[]) {
      const file = await access.resolve(requested);
      if (!(await stat(file)).isFile()) throw new Error('上传路径必须是普通文件。');
      files.push(file);
    }
    await page.upload(args.ref, files, context.signal);
    return { files: files.map(file => path.basename(file)), count: files.length };
  }
  async download(page: BrowserPage, args: Record<string, unknown>, context: ToolContext, click?: () => Promise<unknown>): Promise<SavedDownload> {
    if (!context.workspace || !context.conversationId) throw new Error('下载需要任务绑定工作区。');
    if (typeof args.path !== 'string' || !args.path.trim() || !Object.hasOwn(args, 'expectedHash'))
      throw Object.assign(new Error('请提供保存路径及预期文件哈希；新文件使用 expectedHash: null。'), { code: 'INVALID_ARGUMENTS' });
    const maximumBytes = (args.maxBytes as number | undefined) ?? defaultMaximumBytes;
    let transfer: PendingDownload | undefined;
    if (args.downloadId !== undefined) {
      transfer = this.downloads.get(String(args.downloadId));
      if (!transfer || transfer.contentsId !== page.contents.id) throw new Error('下载引用已失效或不属于此标签。');
      if (transfer.saved) {
        if (transfer.saved.workspaceId !== context.workspace.id || transfer.saved.result.path !== args.path || transfer.saved.expectedHash !== args.expectedHash)
          throw new Error('此下载已保存；请使用原工作区、保存路径和 expectedHash 查询同一回执。');
        return { ...transfer.saved.result };
      }
      if (args.maxBytes !== undefined) transfer.maximumBytes = maximumBytes;
    } else {
      if (!args.ref) throw Object.assign(new Error('请提供 downloadId，或用于发起下载的 ref。'), { code: 'INVALID_ARGUMENTS' });
      if (this.waiting.has(page.contents.id)) throw new Error('此标签已经在等待文件下载。');
    }
    await prepareExternalWrite(this.app, context, 'write_file', { path: args.path });
    await this.app.files.transaction(context.workspace, async transaction => {
      if ((await transaction.capture(String(args.path), false, { hashOnly: true })).hash !== args.expectedHash) throw new Error('FILE_CONFLICT: 目标文件已存在或发生变化，请重新确认保存位置。');
    }, { writeGrants: context.fileWriteGrants });
    context.signal.throwIfAborted();
    const existing = !!transfer;
    if (!transfer) {
      transfer = this.create(page.contents.id, maximumBytes);
      this.waiting.set(page.contents.id, transfer);
    }
    const current = transfer;
    const abort = () => { void this.remove(current, new Error('下载已停止。')).catch(error => this.app.publish({ type: 'browser.transfer.failed', error: String(error) })); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      if (!existing) await (click ? click() : page.action({ action: 'click', ref: args.ref }, context.signal));
      await current.ready; context.signal.throwIfAborted();
      const info = await stat(current.path);
      if (info.size > current.maximumBytes) throw new Error(`下载超过 maxBytes 限额（${current.maximumBytes} 字节）。`);
      await this.app.changes.write(context, [{ path: args.path, sourceFile: current.path, expectedHash: args.expectedHash as string | null }]);
      const result: SavedDownload = { path: args.path, bytes: info.size, filename: current.info.filename, url: current.info.url, downloadId: current.info.downloadId };
      current.saved = { workspaceId: context.workspace.id, expectedHash: args.expectedHash as string | null, result };
      current.info.status = 'saved'; current.detachAbort?.(); current.detachAbort = undefined;
      await this.cleanFile(current);
      return result;
    } catch (error) {
      // 保存位置冲突时保留已完成的下载，模型可以调整路径，无需重复提交网页请求。
      if (context.signal.aborted || !existing && current.info.status !== 'completed' && current.info.status !== 'saved') await this.remove(current);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
      this.clearTimer(current);
    }
  }
}
