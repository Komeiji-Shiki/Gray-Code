import type { DownloadItem, WebContents } from 'electron';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../server/src/application';
import { FileReadAccess } from '../../../server/src/workspace/readAccess';
import { prepareExternalWrite } from '../../../server/src/workspace/writeAccess';
import type { BrowserPage } from './page';

interface PendingDownload { path: string; item?: DownloadItem; reject(error: Error): void; resolve(item: DownloadItem): void }
const maximumBytes = 64 * 1024 * 1024;

/** 下载先保留原请求的正文与登录会话，完成后才通过工作区事务提交目标文件。 */
export class BrowserTransfers {
  private readonly pending = new Map<number, PendingDownload>();
  constructor(private readonly app: PlatformApplication) {}
  receive(contents: WebContents, item: DownloadItem): boolean {
    const transfer = this.pending.get(contents.id);
    if (!transfer || transfer.item) return false;
    transfer.item = item; item.setSavePath(transfer.path);
    const rejectLarge = () => {
      if (item.getTotalBytes() > maximumBytes || item.getReceivedBytes() > maximumBytes) {
        item.cancel(); transfer.reject(new Error('模型下载超过 64 MiB，请接管网页后手动保存此文件。'));
      }
    };
    item.on('updated', rejectLarge); rejectLarge();
    item.once('done', (_event, state) => {
      item.removeListener('updated', rejectLarge);
      if (state === 'completed') transfer.resolve(item); else transfer.reject(new Error(`下载未完成：${state}`));
    });
    return true;
  }
  async upload(page: BrowserPage, args: Record<string, unknown>, context: ToolContext) {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 20 || args.paths.some(value => typeof value !== 'string')) throw new Error('请提供 1 至 20 个文件路径。');
    const access = new FileReadAccess(this.app, context); const files: string[] = [];
    for (const requested of args.paths as string[]) {
      const file = await access.resolve(requested);
      if (!(await stat(file)).isFile()) throw new Error('上传路径必须是普通文件。');
      files.push(file);
    }
    await page.upload(args.ref, files, context.signal);
    return { files: files.map(file => path.basename(file)), count: files.length };
  }
  async download(page: BrowserPage, args: Record<string, unknown>, context: ToolContext) {
    if (!context.workspace || !context.conversationId) throw new Error('下载需要任务绑定工作区。');
    if (typeof args.path !== 'string' || !args.path.trim() || !Object.hasOwn(args, 'expectedHash') || args.expectedHash !== null && typeof args.expectedHash !== 'string')
      throw new Error('请提供保存路径及预期文件哈希；新文件使用 expectedHash: null。');
    if (this.pending.has(page.contents.id)) throw new Error('此标签已经在等待文件下载。');
    await prepareExternalWrite(this.app, context, 'write_file', { path: args.path });
    await this.app.files.transaction(context.workspace, async transaction => {
      if ((await transaction.capture(String(args.path))).hash !== args.expectedHash) throw new Error('FILE_CONFLICT: 目标文件已存在或发生变化，请重新确认保存位置。');
    }, { writeGrants: context.fileWriteGrants });
    context.signal.throwIfAborted();
    const directory = await mkdtemp(path.join(this.app.storage.directory, 'browser-transfer-'));
    const file = path.join(directory, 'download');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const ready = new Promise<DownloadItem>((resolve, reject) => {
      const transfer: PendingDownload = { path: file, resolve, reject }; this.pending.set(page.contents.id, transfer);
      abort = () => { transfer.item?.cancel(); reject(new Error('下载已停止。')); };
      context.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { transfer.item?.cancel(); reject(new Error('下载超时，请在页面确认文件是否仍可下载。')); }, 120000);
    });
    // 先注册异常处理，点击本身失败时也不会留下未处理的下载拒绝。
    void ready.catch(() => {});
    try {
      await page.action({ action: 'click', ref: args.ref }, context.signal);
      const item = await ready; context.signal.throwIfAborted();
      const bytes = await readFile(file);
      await this.app.changes.write(context, [{ path: args.path, bytes, expectedHash: args.expectedHash as string | null }]);
      return { path: args.path, bytes: bytes.length, filename: item.getFilename(), url: item.getURL() };
    } finally {
      this.pending.get(page.contents.id)?.item?.cancel(); this.pending.delete(page.contents.id);
      if (timer) clearTimeout(timer); if (abort) context.signal.removeEventListener('abort', abort);
      // 此目录由本次调用创建，仅包含尚未发布的下载副本。
      if (path.dirname(directory) === path.resolve(this.app.storage.directory) && path.basename(directory).startsWith('browser-transfer-')) await rm(directory, { recursive: true, force: true });
    }
  }
}
