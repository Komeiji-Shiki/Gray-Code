import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDefinition } from '@graycode/contracts';

/** 旧 VS Code URI 可能编码盘符；先还原路径，再比较大小写和分隔符。 */
export function workspaceDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const directory = /^file:/i.test(value) ? fileURLToPath(value) : value;
    return path.isAbsolute(directory) ? path.normalize(directory) : undefined;
  } catch { return undefined; }
}
export function workspaceDirectoryKey(value: unknown): string | undefined {
  const directory = workspaceDirectory(value);
  if (!directory) return undefined;
  const key = directory.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
export function conversationWorkspace(value: { workspaceId?: unknown; workspaceUri?: unknown }, workspaces: readonly WorkspaceDefinition[]) {
  if (typeof value.workspaceId === 'string' && value.workspaceId) return workspaces.find(workspace => workspace.id === value.workspaceId);
  const key = workspaceDirectoryKey(value.workspaceUri);
  const matches = key === undefined ? [] : workspaces.filter(workspace => workspaceDirectoryKey(workspace.directory) === key);
  return matches.length === 1 ? matches[0] : undefined;
}
