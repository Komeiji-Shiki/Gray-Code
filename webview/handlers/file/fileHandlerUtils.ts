/**
 * 文件处理器共享工具与工作区信息
 *
 * 拆分 FileHandlers.ts 时提取的公共部分（域 A）：
 * - 附件大小上限常量：FileReadHandlers / FilePreviewHandlers / FileOpenHandlers 共用
 * - isUriInsideWorkspace：纯路径工作区包含性校验（不 stat，可用于未创建的新文件）
 * - getWorkspaceUri / getRelativePath：工作区信息消息处理器
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../../backend/i18n';
import type { MessageHandler } from '../../types';
import { getRelativePathFromAbsolute } from '../../utils/WorkspaceUtils';

// ========== 附件大小上限 ==========

/**
 * 附件（非文本文件）会整体 base64 编码后经 postMessage 传给 webview：
 * base64 体积膨胀约 1/3，超大文件会拖垮扩展进程内存并阻塞序列化。
 * 超过该上限时拒绝传输/预览，引导用户改用文件选择或预览方式查看。
 */
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_TEXT_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_BASE64_ATTACHMENT_LENGTH = Math.ceil(MAX_ATTACHMENT_SIZE_BYTES / 3) * 4;

// ========== 工作区包含校验 ==========

/**
 * 纯路径包含性校验：判断 URI 是否位于任意已打开的工作区内。
 *
 * 与 validateFileInWorkspace 不同：该函数不访问文件系统（不 stat），
 * 因此可用于尚未创建的新文件场景（如 saveImageToPath）。
 */
export function isUriInsideWorkspace(uri: vscode.Uri): boolean {
  // 优先使用 VSCode API
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (wsFolder) return true;

  // 兜底：手动前缀匹配（处理远程 SSH scheme 不一致等场景）
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;

  const fsPath = uri.fsPath;
  for (const folder of folders) {
    const folderFsPath = folder.uri.fsPath;
    if (fsPath === folderFsPath || fsPath.startsWith(folderFsPath + path.sep)) {
      return true;
    }
  }

  return false;
}

// ========== 工作区信息 ==========

export const getWorkspaceUri: MessageHandler = async (data, requestId, ctx) => {
  const uri = ctx.getCurrentWorkspaceUri();
  ctx.sendResponse(requestId, uri);
};

export const getRelativePath: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { absolutePath } = data || {};
    const relativePath = getRelativePathFromAbsolute(absolutePath);
    
    // 检查是否是目录
    let isDirectory = false;
    try {
      let filePath = absolutePath;
      if (absolutePath.startsWith('file://')) {
        const uri = vscode.Uri.parse(absolutePath);
        filePath = uri.fsPath;
      }
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      isDirectory = stat.type === vscode.FileType.Directory;
    } catch {
      // 无法获取文件信息，默认为文件
    }
    
    ctx.sendResponse(requestId, { relativePath, isDirectory });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_RELATIVE_PATH_ERROR', error.message || t('webview.errors.getRelativePathFailed'));
  }
};

/**
 * 注册工作区信息处理器
 */
export function registerFileUtilsHandlers(registry: Map<string, MessageHandler>): void {
  // 工作区信息
  registry.set('getWorkspaceUri', getWorkspaceUri);
  registry.set('getRelativePath', getRelativePath);
}
