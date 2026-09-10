import { inside, resolveWorkspacePath, workspaceRoots } from './paths';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';

const writers = new Set(['write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory', 'search_in_files']);
function paths(args: Record<string, unknown>): string[] {
  if (typeof args.path === 'string') return [args.path];
  if (Array.isArray(args.paths)) return args.paths.filter((value): value is string => typeof value === 'string');
  return Array.isArray(args.files) ? args.files.map(value => (value as { path?: unknown })?.path).filter((value): value is string => typeof value === 'string') : [];
}

/** 写入前确认具体目标，批准范围随文件操作记录保存，重启恢复不扩大范围。 */
export async function prepareExternalWrite(app: PlatformApplication, context: ToolContext, name: string, args: Record<string, unknown>) {
  if (!writers.has(name) || name === 'search_in_files' && args.mode !== 'replace' || !context.workspace) return;
  const settings = app.product.runtimeSettings();
  const policy = name === 'apply_diff' ? settings.getApplyDiffConfig().outsideWorkspaceAccess : settings.getWriteFileConfig().outsideWorkspaceAccess;
  const roots = await Promise.all(workspaceRoots(context.workspace).map(root => app.files.resolve(context.workspace!, root.directory)));
  const grants: NonNullable<ToolContext['fileWriteGrants']> = [];
  for (const value of paths(args)) {
    const target = await app.files.resolveAbsolute(resolveWorkspacePath(context.workspace, value), name === 'delete_file');
    if (roots.some(root => inside(root, target))) continue;
    if ((context.actor ?? app.actor(context.actorId))?.role !== 'owner') throw new Error('此账号不能修改工作区外的文件。');
    if (policy === 'deny') throw new Error('设置禁止工作区外写入，请将工作区外写入设置改为“询问”后执行。');
    grants.push({ path: target, recursive: ['delete_file', 'create_directory', 'search_in_files'].includes(name) });
  }
  if (!grants.length) return;
  if (!context.approvedByToolConfirmation && (!context.requestApproval || !await context.requestApproval(`修改工作区外的路径：\n${grants.map(grant => grant.path).join('\n')}`))) throw new Error('工作区外写入未获确认。');
  if ((context.actor ?? app.actor(context.actorId))?.role !== 'owner') throw new Error('账号已不能修改工作区外的文件。');
  context.fileWriteGrants = grants;
}
