import { BINARY_FILE_EXTENSIONS, inferMimeTypeByPath, isLikelyTextFile } from '../../../backend/tools/shared/inputFileTypes';
/**
 * 文件读取与类型推断消息处理器
 *
 * 拆分自 FileHandlers.ts 域 C：提示词上下文文件读取（readFileForContext）、
 * 工作区文本文件读取（readWorkspaceTextFile / readWorkspaceFileForInput），
 * 以及文本/二进制类型推断（扩展名表、MIME 推断、字节采样嗅探）。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../../backend/i18n';
import type { MessageHandler } from '../../types';
import {
  isUriInsideWorkspaceRealpath,
  MAX_TEXT_FILE_SIZE_BYTES,
  MAX_ATTACHMENT_SIZE_BYTES
} from './fileHandlerUtils';
import { getRelativePathFromAbsolute } from '../../utils/WorkspaceUtils';

// ========== 提示词上下文文件读取 ==========

export const readFileForContext: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { uri } = data;
    
    if (!uri) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.invalidFileUri')
      });
      return;
    }
    
    // 解析 URI
    let fileUri: vscode.Uri;
    try {
      fileUri = vscode.Uri.parse(uri);
    } catch {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.invalidFileUri')
      });
      return;
    }
    
    // 获取相对路径
    const relativePath = getRelativePathFromAbsolute(fileUri.fsPath);
    if (!relativePath) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.fileNotInWorkspace')
      });
      return;
    }
    
    // 在读取前检查大小，避免把超大文本整体载入扩展进程。
    const stat = await vscode.workspace.fs.stat(fileUri);
    if (stat.size > MAX_TEXT_FILE_SIZE_BYTES) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.readFileFailed') });
      return;
    }
    const content = await vscode.workspace.fs.readFile(fileUri);
    const textContent = Buffer.from(content).toString('utf-8');
    
    ctx.sendResponse(requestId, {
      success: true,
      path: relativePath,
      content: textContent
    });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.readFileFailed')
    });
  }
};

// 通过相对路径读取工作区内文件内容（用于 @ 选择文件后生成徽章）
export const readWorkspaceTextFile: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: relativePath } = data;

    if (!relativePath || typeof relativePath !== 'string') {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.invalidFileUri') });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.noWorkspaceOpen') });
      return;
    }

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

    // realpath 感知校验：防止工作区内 symlink 指向工作区外文件时被词法前缀匹配放行
    if (!(await isUriInsideWorkspaceRealpath(fileUri))) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.fileNotInWorkspace') });
      return;
    }

    const stat = await vscode.workspace.fs.stat(fileUri);
    if (stat.size > MAX_TEXT_FILE_SIZE_BYTES) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.readFileFailed') });
      return;
    }
    const content = await vscode.workspace.fs.readFile(fileUri);
    if (!isLikelyTextFile(relativePath, content)) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.readFileFailed')
      });
      return;
    }

    const textContent = Buffer.from(content).toString('utf-8');

    ctx.sendResponse(requestId, {
      success: true,
      path: relativePath,
      isText: true,
      content: textContent
    });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.readFileFailed')
    });
  }
};

// 读取工作区文件（文本返回 content，非文本返回附件数据）
export const readWorkspaceFileForInput: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: relativePath } = data;

    if (!relativePath || typeof relativePath !== 'string') {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.invalidFileUri') });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.noWorkspaceOpen') });
      return;
    }

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

    // realpath 感知校验：防止工作区内 symlink 指向工作区外文件时被词法前缀匹配放行
    if (!(await isUriInsideWorkspaceRealpath(fileUri))) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.fileNotInWorkspace') });
      return;
    }

    const stat = await vscode.workspace.fs.stat(fileUri);
    const ext = path.extname(relativePath).toLowerCase();
    if (stat.size > MAX_ATTACHMENT_SIZE_BYTES) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.attachmentTooLarge', { maxSizeMB: MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024) })
      });
      return;
    }
    // 大于文本上限时，仅允许扩展名明确标识为二进制的附件继续读取。
    // 未知扩展名需要读取内容才能嗅探，直接拒绝可避免先载入超大文件再判定。
    if (stat.size > MAX_TEXT_FILE_SIZE_BYTES && !BINARY_FILE_EXTENSIONS.has(ext)) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.readFileFailed') });
      return;
    }
    const content = await vscode.workspace.fs.readFile(fileUri);
    const isText = isLikelyTextFile(relativePath, content);

    if (isText) {
      const textContent = Buffer.from(content).toString('utf-8');
      ctx.sendResponse(requestId, {
        success: true,
        path: relativePath,
        isText: true,
        content: textContent
      });
      return;
    }

    // 大文件整体 base64 后塞进 postMessage 会导致扩展进程内存暴涨/序列化阻塞。
    const mimeType = inferMimeTypeByPath(relativePath);

    ctx.sendResponse(requestId, {
      success: true,
      path: relativePath,
      isText: false,
      attachment: {
        name: path.basename(relativePath),
        size: stat.size,
        mimeType,
        data: Buffer.from(content).toString('base64')
      }
    });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.readFileFailed')
    });
  }
};

/**
 * 注册文件读取处理器
 */
export function registerFileReadHandlers(registry: Map<string, MessageHandler>): void {
  // 提示词上下文
  registry.set(MESSAGE_NAMES.readFileForContext, readFileForContext);
  registry.set(MESSAGE_NAMES.readWorkspaceTextFile, readWorkspaceTextFile);
  registry.set(MESSAGE_NAMES.readWorkspaceFileForInput, readWorkspaceFileForInput);
}
