/**
 * 预览展示消息处理器
 *
 * 拆分自 FileHandlers.ts 域 D + 域 A 的临时文件清理：
 * showContextContent（临时文件 + 语言映射）、previewAttachment、readWorkspaceImage、
 * openWorkspaceFile，以及 scheduleTempFileCleanup / TEMP_PREVIEW_TTL_MS。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { t } from '../../../backend/i18n';
import type { MessageHandler } from '../../types';
import {
  isUriInsideWorkspaceRealpath,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_BASE64_ATTACHMENT_LENGTH
} from './fileHandlerUtils';

// ========== 临时预览文件清理 ==========

const TEMP_PREVIEW_TTL_MS = 10 * 60 * 1000;

function scheduleTempFileCleanup(filePath: string): void {
  const timer = setTimeout(() => {
    void fs.promises.rm(filePath, { force: true }).catch(error => {
      console.warn('[FileHandlers] Failed to remove temporary preview file:', error);
    });
  }, TEMP_PREVIEW_TTL_MS);
  timer.unref?.();
}

// ========== 预览展示 ==========

export const showContextContent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { title, content, language } = data;
    
    // 创建临时文件来显示内容（异步 mkdir/writeFile：内容大小由 webview 控制，同步写会阻塞扩展宿主）
    const tempDir = path.join(os.tmpdir(), 'graycode-context-preview');
    await fs.promises.mkdir(tempDir, { recursive: true });
    
    // 根据语言确定扩展名
    const extMap: Record<string, string> = {
      'typescript': '.ts',
      'typescriptreact': '.tsx',
      'javascript': '.js',
      'javascriptreact': '.jsx',
      'python': '.py',
      'vue': '.vue',
      'html': '.html',
      'css': '.css',
      'json': '.json',
      'markdown': '.md',
      'yaml': '.yaml',
      'xml': '.xml',
      'rust': '.rs',
      'go': '.go',
      'java': '.java',
      'csharp': '.cs',
      'cpp': '.cpp',
      'c': '.c',
      'ruby': '.rb',
      'php': '.php',
      'swift': '.swift',
      'kotlin': '.kt',
      'sql': '.sql',
      'shellscript': '.sh'
    };
    const ext = extMap[language || ''] || '.txt';
    
    // 每次预览使用唯一文件名，避免并发请求互相覆盖。
    const safeTitle = (title || 'context').replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const tempFilePath = path.join(tempDir, `preview_${safeTitle}_${uniqueSuffix}${ext}`);
    
    // 写入内容：显式 0600 权限，避免明文内容在 os.tmpdir 下被同机其他用户读取（umask 默认 0644）
    await fs.promises.writeFile(tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });
    
    const uri = vscode.Uri.file(tempFilePath);
    
    // 打开文档，使用 preview 模式（单击预览，再次点击同一文件会复用）
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true
    });
    scheduleTempFileCleanup(tempFilePath);
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || 'Failed to show context content'
    });
  }
};

export const previewAttachment: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { name, data: base64Data } = data || {};
    if (typeof name !== 'string' || !name || typeof base64Data !== 'string' || !base64Data) {
      ctx.sendError(requestId, 'PREVIEW_ATTACHMENT_ERROR', t('webview.errors.previewAttachmentFailed'));
      return;
    }
    // base64 解码前按编码长度预判，避免超大字符串再额外分配完整 Buffer。
    if (base64Data.length > MAX_BASE64_ATTACHMENT_LENGTH) {
      ctx.sendError(requestId, 'PREVIEW_ATTACHMENT_ERROR',
        t('webview.errors.attachmentTooLarge', { maxSizeMB: MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024) }));
      return;
    }
    
    const tempDir = path.join(os.tmpdir(), 'graycode-preview');
    await fs.promises.mkdir(tempDir, { recursive: true });
    
    const timestamp = Date.now();
    const uniqueSuffix = Math.random().toString(36).slice(2, 10);
    const safeFileName = name.replace(/[<>:"/\\|?*]/g, '_');
    const tempFilePath = path.join(tempDir, `${timestamp}_${uniqueSuffix}_${safeFileName}`);
    
    const buffer = Buffer.from(base64Data, 'base64');
    // 与 readWorkspaceFileForInput 共用附件大小上限，拒绝超大附件写入临时目录
    if (buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
      ctx.sendError(
        requestId,
        'PREVIEW_ATTACHMENT_ERROR',
        t('webview.errors.attachmentTooLarge', { maxSizeMB: MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024) })
      );
      return;
    }
    // 显式 0600 权限（与 showContextContent 同口径）：附件明文写入 os.tmpdir，避免其他本地用户可读
    await fs.promises.writeFile(tempFilePath, buffer, { mode: 0o600 });
    
    const uri = vscode.Uri.file(tempFilePath);
    await vscode.commands.executeCommand('vscode.open', uri);
    scheduleTempFileCleanup(tempFilePath);
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'PREVIEW_ATTACHMENT_ERROR', error.message || t('webview.errors.previewAttachmentFailed'));
  }
};

export const readWorkspaceImage: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: imgPath } = data;
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.noWorkspaceOpen') });
      return;
    }
    
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, imgPath);

    // realpath 感知校验：防止工作区内 symlink 指向工作区外文件时被词法前缀匹配放行
    if (!(await isUriInsideWorkspaceRealpath(fileUri))) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.fileNotInWorkspace') });
      return;
    }

    const stat = await vscode.workspace.fs.stat(fileUri);
    if (stat.size > MAX_ATTACHMENT_SIZE_BYTES) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.attachmentTooLarge', { maxSizeMB: MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024) })
      });
      return;
    }
    const content = await vscode.workspace.fs.readFile(fileUri);

    const ext = path.extname(imgPath).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.gif') {
      mimeType = 'image/gif';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    } else if (ext === '.svg') {
      mimeType = 'image/svg+xml';
    } else if (ext === '.bmp') {
      mimeType = 'image/bmp';
    }
    
    const base64 = Buffer.from(content).toString('base64');
    
    ctx.sendResponse(requestId, {
      success: true,
      data: base64,
      mimeType
    });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: t('webview.errors.readImageFailed')
    });
  }
};

export const openWorkspaceFile: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: filePath } = data;
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(t('webview.errors.noWorkspaceOpen'));
    }
    
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

    // realpath 感知校验：防止工作区内 symlink 指向工作区外文件时被词法前缀匹配放行
    if (!(await isUriInsideWorkspaceRealpath(fileUri))) {
      throw new Error(t('webview.errors.fileNotInWorkspace'));
    }

    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      throw new Error(t('webview.errors.fileNotExists'));
    }
    
    await vscode.commands.executeCommand('vscode.open', fileUri);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_WORKSPACE_FILE_ERROR', error.message || t('webview.errors.openFileFailed'));
  }
};

/**
 * 注册预览展示处理器
 */
export function registerFilePreviewHandlers(registry: Map<string, MessageHandler>): void {
  // 预览展示
  registry.set(MESSAGE_NAMES.showContextContent, showContextContent);
  registry.set(MESSAGE_NAMES.previewAttachment, previewAttachment);
  registry.set(MESSAGE_NAMES.readWorkspaceImage, readWorkspaceImage);
  registry.set(MESSAGE_NAMES.openWorkspaceFile, openWorkspaceFile);
}
