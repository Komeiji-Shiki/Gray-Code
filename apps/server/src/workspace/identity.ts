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
/** 批量摘要共用当前设置的索引；同目录的多个工作区仍须用显式 ID 区分。 */
export function conversationWorkspaceIndex(workspaces: readonly WorkspaceDefinition[]) {
  const byId = new Map<string, WorkspaceDefinition>();
  const byDirectory = new Map<string, WorkspaceDefinition | undefined>();
  for (const workspace of workspaces) {
    if (!byId.has(workspace.id)) byId.set(workspace.id, workspace);
    const key = workspaceDirectoryKey(workspace.directory);
    if (key !== undefined) byDirectory.set(key, byDirectory.has(key) ? undefined : workspace);
  }
  return (value: { workspaceId?: unknown; workspaceUri?: unknown }) => {
    if (typeof value.workspaceId === 'string' && value.workspaceId) return byId.get(value.workspaceId);
    const key = workspaceDirectoryKey(value.workspaceUri);
    return key === undefined ? undefined : byDirectory.get(key);
  };
}
