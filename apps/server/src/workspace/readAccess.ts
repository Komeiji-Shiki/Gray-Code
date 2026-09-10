import { inside as contains, resolveWorkspacePath, workspaceRoots } from './paths';
import { realpath, stat } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';

/** 文件读取的目标策略集中在此处，目录遍历和正文读取共用已确认的范围。 */
export class FileReadAccess {
  private readonly allowed: Array<{ path: string; directory: boolean }> = [];
  private roots?: Promise<string[]>;
  constructor(private readonly app: PlatformApplication, private readonly context: ToolContext) {}
  async resolve(requested: string): Promise<string> {
    this.context.signal.throwIfAborted();
    const workspace = this.context.workspace;
    const absolute = resolveWorkspacePath(workspace, requested);
    const roots = workspace ? await (this.roots ??= Promise.all(workspaceRoots(workspace).map(root => realpath(root.directory)))) : [];
    const actor = this.context.actor ?? this.app.actor(this.context.actorId);
    const policy = this.app.product.runtimeSettings().getReadFileConfig().outsideWorkspaceAccess;
    // 明显在范围外的拒绝不需要先访问该文件；真实路径还会识别链接指向的目标。
    if (!roots.some(root => contains(root, absolute)) && (actor?.role !== 'owner' || policy === 'deny'))
      throw new Error('当前账号或读取设置不允许访问工作区外的文件。');
    const actual = await realpath(absolute);
    if (roots.some(root => contains(root, actual))) return actual;
    if (actor?.role !== 'owner' || policy === 'deny') throw new Error('当前账号或读取设置不允许访问工作区外的文件。');
    if (policy === 'allow' || this.context.approvedByToolConfirmation) return actual;
    if (this.allowed.some(item => item.path === actual || item.directory && contains(item.path, actual))) return actual;
    if (!this.context.requestApproval || !await this.context.requestApproval(`读取工作区外的路径：${actual}`)) throw new Error('工作区外读取未获确认。');
    if ((this.context.actor ?? this.app.actor(this.context.actorId))?.role !== 'owner') throw new Error('当前账号已不能读取工作区外路径。');
    this.allowed.push({ path: actual, directory: (await stat(actual)).isDirectory() });
    return actual;
  }
}
