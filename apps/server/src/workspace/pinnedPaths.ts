import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkspaceDefinition, WorkspaceRootDefinition } from '@graycode/contracts';
import type { PinnedFileItem } from '../../../../backend/modules/settings/types';
import { inside, workspaceFilePath, workspaceRoots } from './paths';

export function pinnedWorkspaceRoot(workspace: WorkspaceDefinition, uri: string): WorkspaceRootDefinition | undefined {
  try {
    const directory = fileURLToPath(uri);
    return workspaceRoots(workspace).find(root => path.relative(root.directory, directory) === '');
  } catch { return undefined; }
}

/** 固定文件继续以实际目录 URI 和相对路径保存，目录名称只用于当前界面显示。 */
export function pinnedFileLocation(workspace: WorkspaceDefinition, file: Pick<PinnedFileItem, 'path' | 'workspaceUri'>) {
  const root = pinnedWorkspaceRoot(workspace, file.workspaceUri);
  if (!root) return undefined;
  const absolute = file.path.startsWith('file:') ? fileURLToPath(file.path) : path.resolve(root.directory, file.path);
  if (!inside(root.directory, absolute)) throw new Error('固定文件不属于记录的目录。');
  return { absolute, path: workspaceFilePath(workspace, absolute), workspaceUri: pathToFileURL(root.directory).toString() };
}
