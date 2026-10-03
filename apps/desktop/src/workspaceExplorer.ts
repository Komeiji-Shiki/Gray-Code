import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PlatformApplication } from '../../server/src/application';
import { resolveWorkspacePath, workspaceRootFor } from '../../server/src/workspace/paths';
import { officeFormatFor } from '../../../shared/officeFormats';

interface ExplorerShell { openPath(path: string): Promise<string>; showItemInFolder(path: string): void }

export async function openOfficeFile(app: PlatformApplication, shell: ExplorerShell, actorId: string,
  input: { workspaceId: string; path: string }) {
  app.requireOwner(actorId);
  const workspace = app.workspace(actorId, input.workspaceId, ['workspace_read']);
  const file = await app.files.resolve(workspace, input.path);
  if (!officeFormatFor(file) || !(await stat(file)).isFile()) throw new Error('请选择工作区内的 DOCX、XLSX 或 PPTX 文件。');
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return { success: true as const };
}

async function openFolder(shell: ExplorerShell, directory: string) {
  if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('工作区文件夹不存在。');
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return { success: true as const };
}

/** 文件只在资源管理器中定位，目录则打开内容；复用当前工作区的多根路径解析。 */
export async function revealWorkspaceFile(app: PlatformApplication, shell: ExplorerShell, actorId: string,
  input: { workspaceId: string; path: string }) {
  app.requireOwner(actorId);
  const workspace = app.workspace(actorId, input.workspaceId, ['workspace_read']);
  const file = resolveWorkspacePath(workspace, input.path);
  if (!workspaceRootFor(workspace, file)) throw new Error('请选择当前工作区内的文件。');
  const info = await stat(file);
  if (info.isDirectory()) return openFolder(shell, file);
  shell.showItemInFolder(file);
  return { success: true as const };
}

export async function openWorkspaceInExplorer(app: PlatformApplication, shell: ExplorerShell, actorId: string,
  input: { workspaceId?: string; workspaceUri?: string; conversationId?: string }) {
  app.requireOwner(actorId);
  const conversation = input.conversationId ? await app.conversation(actorId, input.conversationId) : undefined;
  const workspaceId = conversation ? conversation.workspaceId : input.workspaceId;
  const uri = conversation ? conversation.workspaceUri : input.workspaceUri;
  const directory = workspaceId ? app.workspace(actorId, String(workspaceId), ['workspace_read']).directory
    : typeof uri === 'string' && uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
  if (!directory) throw new Error('当前对话没有可打开的本机工作区。');
  return openFolder(shell, directory);
}
