/**
 * 工作区文件打开/保存与跳转高亮消息处理器
 *
 * 拆分自 FileHandlers.ts 域 E + F：
 * - 模块级跳转高亮状态（jumpHighlightDecorationType / jumpHighlightTimers）与其
 *   创建、应用、清理逻辑（disposeFileHandlerResources）同文件维护，避免资源泄漏；
 * - openWorkspaceFileAt（行号解析 + 定位 + 临时高亮）、saveImageToPath。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../../types';
import {
  isUriInsideWorkspace,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_BASE64_ATTACHMENT_LENGTH
} from './fileHandlerUtils';
import { validateFileInWorkspace } from '../../utils/WorkspaceUtils';

// ========== 工作区文件跳转（带行号/临时高亮） ==========

let jumpHighlightDecorationType: vscode.TextEditorDecorationType | null = null;
const jumpHighlightTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 装饰类型是否已登记统一销毁逻辑（避免重复 push subscriptions） */
let jumpHighlightDisposeRegistered = false;

function getJumpHighlightDecorationType(ctx: HandlerContext): vscode.TextEditorDecorationType {
  if (!jumpHighlightDecorationType) {
    jumpHighlightDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
  }

  // 无条件登记统一销毁逻辑：装饰类型（模块级单例）与尚未触发的计时器必须始终可释放。
  // 登记不依赖创建时机——即使首次创建时 ctx.context 缺失，后续任意一次调用
  // 只要拿到 subscriptions 也会补登记；context 始终缺失时由
  // ChatViewProvider.dispose → disposeFileHandlerResources() 兜底释放。
  if (!jumpHighlightDisposeRegistered && ctx.context?.subscriptions) {
    jumpHighlightDisposeRegistered = true;
    ctx.context.subscriptions.push({ dispose: disposeFileHandlerResources });
  }
  return jumpHighlightDecorationType;
}

function clearJumpHighlightForUri(uriString: string): void {
  if (!jumpHighlightDecorationType) return;
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriString) {
      try {
        editor.setDecorations(jumpHighlightDecorationType, []);
      } catch {
        // 扩展销毁期间 editor/decoration 可能已释放。
      }
    }
  }
}

export function disposeFileHandlerResources(): void {
  for (const timer of jumpHighlightTimers.values()) clearTimeout(timer);
  jumpHighlightTimers.clear();
  jumpHighlightDecorationType?.dispose();
  jumpHighlightDecorationType = null;
  // 复位登记标记：装饰若在 dispose 后被重新创建，仍可重新登记销毁逻辑
  jumpHighlightDisposeRegistered = false;
}

function applyTemporaryJumpHighlight(ctx: HandlerContext, uri: vscode.Uri, range: vscode.Range, durationMs: number): void {
  const deco = getJumpHighlightDecorationType(ctx);
  const uriString = uri.toString();

  const existingTimer = jumpHighlightTimers.get(uriString);
  if (existingTimer) {
    clearTimeout(existingTimer);
    jumpHighlightTimers.delete(uriString);
  }

  // 先清理旧的装饰，再应用新的范围
  clearJumpHighlightForUri(uriString);
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriString) {
      editor.setDecorations(deco, [{ range }]);
    }
  }

  const timer = setTimeout(() => {
    clearJumpHighlightForUri(uriString);
    jumpHighlightTimers.delete(uriString);
  }, durationMs);
  jumpHighlightTimers.set(uriString, timer);
}

function toPositiveInt(value: any): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

function normalizeIncomingWorkspacePath(raw: any): string {
  let p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return '';

  // 去掉常见包裹符号（例如 AI 输出时的引号/反引号）
  p = p.replace(/^["'`]+/, '').replace(/["'`]+$/, '');

  // 相对路径：将反斜杠转为正斜杠，避免 vscode.Uri.joinPath 把 \" 当作文件名字符
  const isWindowsDriveAbs = /^[A-Za-z]:[\\/]/.test(p);
  const isUri = /^(file:\/\/|vscode-remote:\/\/)/i.test(p);
  if (!isWindowsDriveAbs && !isUri && !path.isAbsolute(p)) {
    p = p.replace(/\\/g, '/');
  }

  // 去掉 ./ 或 .\ 前缀
  p = p.replace(/^(?:\.\/|\.\\)/, '');

  return p;
}

export const openWorkspaceFileAt: MessageHandler = async (data, requestId, ctx) => {
  try {
    const filePathRaw = data?.path;
    const filePath = normalizeIncomingWorkspacePath(filePathRaw);
    if (!filePath) {
      ctx.sendError(requestId, 'OPEN_WORKSPACE_FILE_AT_ERROR', t('webview.errors.invalidFileUri'));
      return;
    }

    const highlight = data?.highlight !== false;
    const preview = data?.preview !== false;
    const highlightDurationMs = toPositiveInt(data?.highlightDurationMs) ?? 3200;

    const startLineInput = toPositiveInt(data?.startLine);
    const endLineInput = toPositiveInt(data?.endLine) ?? startLineInput;

    const startCharacterInput = toPositiveInt(data?.startCharacter);
    const endCharacterInput = toPositiveInt(data?.endCharacter);

    const currentWorkspaceUri = ctx.getCurrentWorkspaceUri?.() || undefined;
    const validation = await validateFileInWorkspace(filePath, currentWorkspaceUri);
    if (!validation.valid || !validation.relativePath) {
      const msg = validation.error || t('webview.errors.fileNotInWorkspace');
      ctx.sendError(requestId, 'OPEN_WORKSPACE_FILE_AT_ERROR', msg);
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === validation.workspaceUri) ||
      vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      ctx.sendError(requestId, 'OPEN_WORKSPACE_FILE_AT_ERROR', t('webview.errors.noWorkspaceOpen'));
      return;
    }

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, validation.relativePath);
    const doc = await vscode.workspace.openTextDocument(fileUri);

    // 仅当提供了行号时才定位/高亮
    if (startLineInput) {
      const maxLine = Math.max(1, doc.lineCount);
      let startLine = Math.min(Math.max(1, startLineInput), maxLine);
      let endLine = Math.min(Math.max(1, endLineInput || startLine), maxLine);
      if (endLine < startLine) {
        const tmp = startLine;
        startLine = endLine;
        endLine = tmp;
      }

      const startLine0 = startLine - 1;
      const endLine0 = endLine - 1;

      const startLineText = doc.lineAt(startLine0).text;
      const endLineText = doc.lineAt(endLine0).text;

      const startChar = Math.min(Math.max(0, (startCharacterInput ?? 0)), startLineText.length);
      const endChar = endCharacterInput !== undefined
        ? Math.min(Math.max(0, endCharacterInput), endLineText.length)
        : endLineText.length;

      // 光标定位在起始行；高亮覆盖范围用 whole-line（更醒目）
      const selection = new vscode.Range(startLine0, startChar, startLine0, startChar);
      const highlightRange = new vscode.Range(startLine0, 0, endLine0, endLineText.length);

      const editor = await vscode.window.showTextDocument(doc, {
        preview,
        preserveFocus: false,
        selection
      });

      editor.revealRange(highlightRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

      if (highlight) {
        applyTemporaryJumpHighlight(ctx, doc.uri, highlightRange, highlightDurationMs);
      }
    } else {
      // 无行号：仅打开文件
      await vscode.window.showTextDocument(doc, {
        preview,
        preserveFocus: false
      });
    }

    ctx.sendResponse(requestId, { success: true, path: validation.relativePath });
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_WORKSPACE_FILE_AT_ERROR', error.message || t('webview.errors.openFileFailed'));
  }
};

export const saveImageToPath: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { data: base64Data, path: imgPath } = data || {};
    if (typeof imgPath !== 'string' || !imgPath.trim()
        || typeof base64Data !== 'string' || !base64Data.trim()) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.saveImageFailed') });
      return;
    }
    if (base64Data.length > MAX_BASE64_ATTACHMENT_LENGTH) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.attachmentTooLarge', { maxSizeMB: MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024) })
      });
      return;
    }
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(t('webview.errors.noWorkspaceOpen'));
    }
    
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, imgPath);

    // 防止路径穿越：imgPath 含 `..` 可逃逸工作区覆写任意文件
    if (!isUriInsideWorkspace(fileUri)) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.fileNotInWorkspace')
      });
      return;
    }

    const dirUri = vscode.Uri.joinPath(fileUri, '..');
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // 目录可能已存在
    }
    
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.saveImageFailed') });
      return;
    }
    await vscode.workspace.fs.writeFile(fileUri, buffer);
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.saveImageFailed')
    });
  }
};

/**
 * 注册工作区文件打开/保存处理器
 */
export function registerFileOpenHandlers(registry: Map<string, MessageHandler>): void {
  // 工作区文件跳转与保存
  registry.set('openWorkspaceFileAt', openWorkspaceFileAt);
  registry.set('saveImageToPath', saveImageToPath);
}
