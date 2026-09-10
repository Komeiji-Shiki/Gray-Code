import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../server/src/application';
import { ApplicationRouter, type ClientSession } from '../../server/src/transport/router';
import { workspaceFilePath, workspaceRootFor } from '../../server/src/workspace/paths';

/** Windows 文件关联和命令行共用路径解析；启动选项的值不能当成待打开文件。 */
export function desktopFileArguments(args: string[], directory: string): string[] {
  const result: string[] = [];
  const valueOptions = new Set(['--data', '--web-port', '--web-token-env', '--web-origin']);
  let filesOnly = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!filesOnly && value === '--') { filesOnly = true; continue; }
    if (!filesOnly && valueOptions.has(value)) { index++; continue; }
    if (!filesOnly && value.startsWith('-')) continue;
    if (!value || value.includes('\0') || /^[a-z][a-z\d+.-]*:\/\//i.test(value) && !value.startsWith('file:')) continue;
    const absolute = value.startsWith('file:') ? fileURLToPath(value) : path.resolve(directory, value);
    if (!result.includes(absolute)) result.push(absolute);
  }
  return result;
}

export async function openDesktopPath(app: PlatformApplication, client: ClientSession, input: string): Promise<void> {
  app.requireOwner(client.actorId);
  const absolute = await realpath(input); const info = await stat(absolute);
  if (!info.isFile() && !info.isDirectory()) throw new Error('请选择文件或文件夹。');
  const candidates = app.settings.snapshot().settings.workspaces
    .map(workspace => ({ workspace, root: workspaceRootFor(workspace, absolute) }))
    .filter(item => item.root).sort((a, b) => b.root!.directory.length - a.root!.directory.length);
  const router = new ApplicationRouter(app);
  const directory = info.isDirectory() ? absolute : path.dirname(absolute);
  const workspace = candidates[0]?.workspace ?? await router.call(client, 'workspaces.add', {
    directory, name: path.basename(directory) || directory,
  }) as WorkspaceDefinition;
  if (info.isFile()) {
    const file = workspaceFilePath(workspace, absolute);
    // 核心复用现有文档，已经编辑但未保存的内容不会被磁盘版本替换。
    await router.call(client, 'documents.open', { workspaceId: workspace.id, path: file });
    app.publish({ type: 'workspace.file.open', clientId: client.clientId, workspaceId: workspace.id, path: file, source: 'desktop' });
  } else app.publish({ type: 'workspace.selected', clientId: client.clientId, workspaceId: workspace.id, source: 'desktop' });
}

/** 等编辑器订阅事件后再打开文件，启动中或重载期间收到的文件按顺序保留。 */
export class DesktopOpenFiles {
  private pending: string[] = [];
  private ready = false;
  private running?: Promise<void>;
  constructor(private readonly open: (file: string) => Promise<void>, private readonly failure: (file: string, error: unknown) => void) {}
  enqueue(files: string[]): void { this.pending.push(...files); void this.drain(); }
  suspend(): void { this.ready = false; }
  async clientReady(): Promise<void> { this.ready = true; await this.drain(); }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.ready || !this.pending.length) return Promise.resolve();
    this.running = (async () => {
      while (this.ready && this.pending.length) {
        const file = this.pending.shift()!;
        try { await this.open(file); } catch (error) { this.failure(file, error); }
      }
    })().finally(() => { this.running = undefined; if (this.ready && this.pending.length) void this.drain(); });
    return this.running;
  }
}
