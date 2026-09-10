import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkspaceDefinition, WorkspaceRootDefinition } from '@graycode/contracts';
import { parseNamedWorkspacePath } from '../../../../backend/tools/shared/workspacePathParsing';
import { createRuntimeWorkspaceRoots } from '../../../../backend/modules/checkpoint/CheckpointWorkspace';

export function workspaceRoots(workspace: WorkspaceDefinition): readonly WorkspaceRootDefinition[] {
  return workspace.roots ?? [{ name: workspace.name, directory: workspace.directory }];
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function workspaceRootFor(workspace: WorkspaceDefinition, absolute: string): WorkspaceRootDefinition | undefined {
  // 嵌套目录采用最接近目标的根，返回的名称前缀可以再次准确解析。
  return workspaceRoots(workspace).filter(root => inside(root.directory, absolute)).sort((a, b) => b.directory.length - a.directory.length)[0];
}

export function parseWorkspacePath(workspace: WorkspaceDefinition, file: string) {
  return parseNamedWorkspacePath(file.replaceAll('\\', '/'), workspaceRoots(workspace));
}

export function resolveWorkspacePath(workspace: WorkspaceDefinition | undefined, file: string): string {
  if (typeof file !== 'string' || file.includes('\0')) throw new Error('工作区路径无效。');
  if (file.startsWith('file:')) return fileURLToPath(file);
  if (path.isAbsolute(file)) return path.resolve(file);
  if (!workspace) throw new Error('没有工作区时请提供绝对路径。');
  const parsed = parseWorkspacePath(workspace, file || '.');
  if (!parsed.workspace) throw new Error(parsed.error);
  return path.resolve(parsed.workspace.directory, parsed.relativePath);
}

export function workspaceFilePath(workspace: WorkspaceDefinition, absolute: string, forcePrefix = false): string {
  const root = workspaceRootFor(workspace, absolute);
  if (!root) return absolute;
  const relative = path.relative(root.directory, absolute).replaceAll('\\', '/');
  return workspaceRoots(workspace).length > 1 || forcePrefix ? `@${root.name}${relative ? '/' + relative : ''}` : relative || '.';
}

export function workspaceSnapshotRoots(workspace: WorkspaceDefinition) {
  return createRuntimeWorkspaceRoots(workspaceRoots(workspace).map(root => ({
    name: root.name, uri: pathToFileURL(root.directory).toString(), fsPath: root.directory,
  })));
}

export function workspaceForRoot(workspace: WorkspaceDefinition, directory?: string): WorkspaceDefinition {
  const root = workspaceRoots(workspace).find(root => path.relative(root.directory, directory ?? workspace.directory) === '');
  if (!root) throw new Error('请选择当前工作区中已登记的目录。');
  return { ...workspace, name: root.name, directory: root.directory, roots: undefined };
}
