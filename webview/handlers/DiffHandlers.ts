/**
 * Diff 预览消息处理器
 */

import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import { getDiffManager } from '../../backend/tools/file/diffManager';
import type { HandlerContext, MessageHandler } from '../types';
import { resolveTargetWorkspaceFolder } from './FileHandlers';

/**
 * diffContentId 白名单：全局 diff ID 由 DiffStorageManager.generateDiffId() 生成
 * （diff_<timestamp>_<base36>），只允许字母数字与 - _。
 * 拒绝含路径分隔符（/ \ . 等）的输入，防止含 ../ 的 diffContentId
 * 在 loadGlobalDiff 内部 path.join 时穿越 diffs 目录读取任意 .json 文件。
 */
const DIFF_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidDiffContentId(diffContentId: unknown): diffContentId is string {
  return typeof diffContentId === 'string' && DIFF_CONTENT_ID_PATTERN.test(diffContentId);
}

/**
 * 打开 Diff 预览
 */
export const openDiffPreview: MessageHandler = async (data, requestId, ctx) => {
  try {
    await handleOpenDiffPreview(data, ctx);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_DIFF_PREVIEW_ERROR', error.message || t('webview.errors.openDiffPreviewFailed'));
  }
};

/**
 * 加载 Diff 内容
 */
export const loadDiffContent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { diffContentId } = data;
    if (!isValidDiffContentId(diffContentId)) {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.invalidDiffData')
      });
      return;
    }
    const content = await ctx.diffStorageManager.loadGlobalDiff(diffContentId);
    if (content) {
      ctx.sendResponse(requestId, {
        success: true,
        originalContent: content.originalContent,
        newContent: content.newContent,
        filePath: content.filePath
      });
    } else {
      ctx.sendResponse(requestId, {
        success: false,
        error: t('webview.errors.diffContentNotFound')
      });
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'LOAD_DIFF_CONTENT_ERROR', error.message || t('webview.errors.loadDiffContentFailed'));
  }
};

/**
 * 处理打开 Diff 预览的内部逻辑
 */
async function handleOpenDiffPreview(
  data: {
    toolId: string;
    toolName: string;
    filePaths: string[];
    args: Record<string, unknown>;
    result?: Record<string, unknown>;
  },
  ctx: HandlerContext
): Promise<void> {
  const { toolId, toolName, args, result } = data;
  
  // 多工作区支持：用当前激活工作区（跟随活动编辑器/用户固定）替代旧的"恒取第一个文件夹"
  const workspaceFolder = resolveTargetWorkspaceFolder(ctx);
  if (!workspaceFolder) {
    throw new Error(t('webview.errors.noWorkspaceOpen'));
  }
  
  if (toolName === 'apply_diff') {
    await handleApplyDiffPreview(args, result, ctx, toolId);
  } else if (toolName === 'search_in_files') {
    await handleSearchInFilesPreview(result, ctx, toolId);
  } else if (toolName === 'write_file') {
    await handleWriteFilePreview(args, result, ctx, toolId);
  } else if (toolName === 'insert_code' || toolName === 'delete_code') {
    await handleDiffContentIdPreview(result, ctx, toolId);
  } else {
    throw new Error(t('webview.errors.unsupportedToolType', { toolName }));
  }
}

/**
 * 处理 apply_diff 预览
 */
async function handleApplyDiffPreview(
  args: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  ctx: HandlerContext,
  toolId?: string
): Promise<void> {
  const filePath = args.path as string;
  const patch = args.patch as string | undefined;
  // 结构化 hunks（推荐新格式）
  const hunks = args.hunks as Array<{ oldContent: string; newContent: string; startLine?: number }> | undefined;
  // legacy fallback
  const diffs = args.diffs as Array<{ search: string; replace: string; start_line?: number }> | undefined;
  
  if (!filePath || (!patch && (!hunks || hunks.length === 0) && (!diffs || diffs.length === 0))) {
    throw new Error(t('webview.errors.invalidDiffData'));
  }
  
  const resultData = result?.data as Record<string, unknown> | undefined;
  let fullOriginalContent = resultData?.originalContent as string | undefined;
  let fullNewContent = resultData?.newContent as string | undefined;
  
  const diffContentId = resultData?.diffContentId as string | undefined;
  if (diffContentId && isValidDiffContentId(diffContentId) && (!fullOriginalContent || !fullNewContent)) {
    try {
      const loadedContent = await ctx.diffStorageManager.loadGlobalDiff(diffContentId);
      if (loadedContent) {
        fullOriginalContent = loadedContent.originalContent;
        fullNewContent = loadedContent.newContent;
      }
    } catch (e) {
      console.warn('Failed to load diff content:', e);
    }
  }
  
  let originalContent: string;
  let newContent: string;
  let diffTitle: string;
  
  if (fullOriginalContent && fullNewContent) {
    originalContent = fullOriginalContent;
    newContent = fullNewContent;
    diffTitle = t('webview.messages.fullFileDiffPreview', { filePath });
  } else if (patch) {
    const built = buildPreviewContentsFromUnifiedPatch(patch);
    originalContent = built.originalContent;
    newContent = built.newContent;
    diffTitle = t('webview.messages.historyDiffPreview', { filePath });
  } else if (hunks && hunks.length > 0) {
    // 结构化 hunks 预览：拼接各 hunk 的 oldContent / newContent
    originalContent = hunks.map((h, i) => `// === Hunk #${i + 1}${h.startLine !== undefined ? ` (Line ${h.startLine})` : ''} ===\n${h.oldContent}`).join('\n\n');
    newContent = hunks.map((h, i) => `// === Hunk #${i + 1}${h.startLine !== undefined ? ` (Line ${h.startLine})` : ''} ===\n${h.newContent}`).join('\n\n');
    diffTitle = t('webview.messages.historyDiffPreview', { filePath });
  } else {
    // legacy diffs preview
    const safeDiffs = diffs || [];
    originalContent = safeDiffs.map((d, i) => `// === Diff #${i + 1}${d.start_line ? ` (Line ${d.start_line})` : ''} ===\n${d.search}`).join('\n\n');
    newContent = safeDiffs.map((d, i) => `// === Diff #${i + 1}${d.start_line ? ` (Line ${d.start_line})` : ''} ===\n${d.replace}`).join('\n\n');
    diffTitle = t('webview.messages.historyDiffPreview', { filePath });
  }
  
  const previewId = diffContentId || toolId || `${filePath}:${Date.now()}`;
  await openDiffView(filePath, originalContent, newContent, diffTitle, ctx, previewId);
}

function buildPreviewContentsFromUnifiedPatch(patch: string): { originalContent: string; newContent: string } {
  const normalized = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const oldOut: string[] = []
  const newOut: string[] = []

  let currentHeader: string | null = null
  let oldBlock: string[] = []
  let newBlock: string[] = []
  let inHunk = false

  const flush = () => {
    if (!inHunk) return

    const hasContent = oldBlock.length > 0 || newBlock.length > 0

    if (currentHeader) {
      oldOut.push(`// ${currentHeader}`)
      newOut.push(`// ${currentHeader}`)
    }

    oldOut.push(...oldBlock)
    newOut.push(...newBlock)

    // 只在 hunk 有实质内容时才加空行分隔，避免连续空行噪声
    if (hasContent) {
      oldOut.push('')
      newOut.push('')
    }

    oldBlock = []
    newBlock = []
  }

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // flush previous hunk
      flush()
      currentHeader = line
      inHunk = true
      continue
    }

    if (!inHunk) {
      // skip headers
      continue
    }

    if (line.startsWith('\\')) {
      // "\\ No newline at end of file"
      continue
    }

    // 纯空行（无前缀）：unified diff 的空行上下文总是以 " " 开头，
    // 所以 line === '' 只会是 patch 头尾 split 噪声或分隔空行，安全跳过
    if (line === '') {
      continue
    }

    const prefix = line[0]
    const content = line.length > 0 ? line.slice(1) : ''

    if (prefix === ' ') {
      oldBlock.push(content)
      newBlock.push(content)
    } else if (prefix === '-') {
      oldBlock.push(content)
    } else if (prefix === '+') {
      newBlock.push(content)
    } else {
      // 兜底：AI 可能漏掉前缀，将其当作 context 行
      oldBlock.push(line)
      newBlock.push(line)
    }
  }

  // flush last hunk
  flush()

  return {
    originalContent: oldOut.join('\n').trimEnd(),
    newContent: newOut.join('\n').trimEnd()
  }
}

/**
 * 处理 search_in_files 替换预览
 */
async function handleSearchInFilesPreview(
  result: Record<string, unknown> | undefined,
  ctx: HandlerContext,
  toolId?: string
): Promise<void> {
  const resultData = result?.data as Record<string, unknown> | undefined;
  const isReplaceMode = resultData?.isReplaceMode as boolean | undefined;
  
  if (!isReplaceMode) {
    throw new Error(t('webview.errors.searchNotReplaceMode'));
  }
  
  const replaceResults = resultData?.results as Array<{
    file: string;
    replacements: number;
    diffContentId?: string;
  }> | undefined;
  
  if (!replaceResults || replaceResults.length === 0) {
    throw new Error(t('webview.errors.noReplaceResults'));
  }
  
  for (const replaceResult of replaceResults) {
    if (!replaceResult.diffContentId || !isValidDiffContentId(replaceResult.diffContentId)) {
      continue;
    }
    
    try {
      const loadedContent = await ctx.diffStorageManager.loadGlobalDiff(replaceResult.diffContentId);
      if (loadedContent) {
        const diffTitle = t('webview.messages.searchReplaceDiffPreview', { filePath: replaceResult.file });
        const previewId = replaceResult.diffContentId || toolId || `${replaceResult.file}:${Date.now()}`;
        await openDiffView(replaceResult.file, loadedContent.originalContent, loadedContent.newContent, diffTitle, ctx, previewId);
      }
    } catch (e) {
      console.warn('Failed to load diff content for search_in_files:', e);
    }
  }
}

/**
 * 处理 write_file 预览
 */
async function handleWriteFilePreview(
  args: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  ctx: HandlerContext,
  toolId?: string
): Promise<void> {
  // 兼容批量格式 (files 数组) 和单文件格式 (path + content)
  let files = args.files as Array<{ path: string; content: string }> | undefined;
  if (!files || files.length === 0) {
    // 回退到单文件参数格式
    const singlePath = args.path as string | undefined;
    const singleContent = args.content as string | undefined;
    if (singlePath) {
      files = [{ path: singlePath, content: singleContent || '' }];
    }
  }

  if (!files || files.length === 0) {
    throw new Error(t('webview.errors.noFileContent'));
  }
  
  const resultData = result?.data as Record<string, unknown> | undefined;
  const writeResults = resultData?.results as Array<{
    path: string;
    diffContentId?: string;
    action?: 'created' | 'modified' | 'unchanged';
  }> | undefined;
  
  const diffContentIdMap = new Map<string, string>();
  if (writeResults) {
    for (const r of writeResults) {
      if (r.diffContentId) {
        diffContentIdMap.set(r.path, r.diffContentId);
      }
    }
  }
  
  for (const file of files) {
    let originalContent = '';
    let newContent = file.content;
    let diffTitle: string;
    
    const diffContentId = diffContentIdMap.get(file.path);
    if (diffContentId && isValidDiffContentId(diffContentId)) {
      try {
        const loadedContent = await ctx.diffStorageManager.loadGlobalDiff(diffContentId);
        if (loadedContent) {
          originalContent = loadedContent.originalContent;
          newContent = loadedContent.newContent;
          diffTitle = t('webview.messages.fullFileDiffPreview', { filePath: file.path });
        } else {
          diffTitle = t('webview.messages.newFileContentPreview', { filePath: file.path });
        }
      } catch (e) {
        console.warn('Failed to load diff content for write_file:', e);
        diffTitle = t('webview.messages.newFileContentPreview', { filePath: file.path });
      }
    } else {
      diffTitle = t('webview.messages.newFileContentPreview', { filePath: file.path });
    }
    
    const previewId = diffContentId || (toolId ? `${toolId}:${file.path}` : `${file.path}:${Date.now()}`);
    await openDiffView(file.path, originalContent, newContent, diffTitle, ctx, previewId);
  }
}

/**
 * 通用：通过 result.data.results 中的 diffContentId 打开预览
 * 适用于 insert_code、delete_code 等结构一致的工具
 */
async function handleDiffContentIdPreview(
  result: Record<string, unknown> | undefined,
  ctx: HandlerContext,
  toolId?: string
): Promise<void> {
  const resultData = result?.data as Record<string, unknown> | undefined;
  const results = resultData?.results as Array<{
    path: string;
    diffContentId?: string;
  }> | undefined;

  if (!results || results.length === 0) {
    throw new Error(t('webview.errors.noReplaceResults'));
  }

  for (const item of results) {
    if (!item.diffContentId || !isValidDiffContentId(item.diffContentId)) {
      continue;
    }

    try {
      const loadedContent = await ctx.diffStorageManager.loadGlobalDiff(item.diffContentId);
      if (loadedContent) {
        const diffTitle = t('webview.messages.fullFileDiffPreview', { filePath: item.path });
        const previewId = item.diffContentId || toolId || `${item.path}:${Date.now()}`;
        await openDiffView(item.path, loadedContent.originalContent, loadedContent.newContent, diffTitle, ctx, previewId);
      }
    } catch (e) {
      console.warn('Failed to load diff content:', e);
    }
  }
}

/**
 * 打开 Diff 视图
 */
async function openDiffView(
  filePath: string,
  originalContent: string,
  newContent: string,
  diffTitle: string,
  ctx: HandlerContext,
  previewId?: string
): Promise<void> {
  const id = previewId && String(previewId).trim() ? String(previewId).trim() : `${filePath}:${Date.now()}`;
  const originalUri = vscode.Uri.parse(`graycode-diff-preview:original/${encodeURIComponent(filePath)}?id=${encodeURIComponent(id)}`);
  const newUri = vscode.Uri.parse(`graycode-diff-preview:modified/${encodeURIComponent(filePath)}?id=${encodeURIComponent(id)}`);
  
  ctx.diffPreviewProvider.setContent(originalUri.toString(), originalContent);
  ctx.diffPreviewProvider.setContent(newUri.toString(), newContent);

  // 修改原因：vscode.diff 不带 viewColumn 时在“当前活动编辑器组”打开，焦点在 SubAgent Monitor 面板时
  //          diff 会开在 Monitor 旁边而不是主聊天侧，用户主窗口的 diff 位置被面板“抢走”。
  // 修改方式：优先使用路由下发的主聊天列（diffViewColumn），其次主区域第一列。
  // 修改目的：diff 预览固定跟随主聊天所在列，不再受 Monitor 面板焦点影响。
  const viewColumn = ctx.diffViewColumn ?? vscode.ViewColumn.One;
  await vscode.commands.executeCommand('vscode.diff', originalUri, newUri, diffTitle, {
    preview: false,
    viewColumn
  });
  // 兜底：vscode.diff 的 viewColumn 参数在部分布局/版本下不生效（会在当前活动编辑器组打开，
  // 焦点在 Monitor 面板时 diff 会落到 Monitor 列）。用 moveActiveEditor 把刚打开的 diff tab
  // 校正到目标列；目标列即当前列时移动是幂等的。
  try {
    await vscode.commands.executeCommand('vscode.moveActiveEditor', { to: 'position', value: viewColumn });
  } catch (moveErr) {
    console.warn('[DiffHandlers] Failed to move diff preview to target column:', moveErr);
  }
}

/**
 * 接受 Diff 修改
 */
export const acceptDiff: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { sessionId } = data;
    const diffManager = getDiffManager();

    if (diffManager.isDiffActionInProgress(sessionId)) {
      ctx.sendError(requestId, 'DIFF_ALREADY_PROCESSING', t('webview.errors.diffAlreadyProcessing'));
      return;
    }

    const diff = diffManager.getDiff(sessionId);
    if (!diff || diff.status !== 'pending') {
      ctx.sendError(requestId, 'DIFF_NOT_PENDING', t('webview.errors.diffNotPending'));
      return;
    }

    const success = await diffManager.acceptDiff(sessionId, true);
    if (!success) {
      ctx.sendError(requestId, 'DIFF_ACCEPT_FAILED', t('webview.errors.acceptDiffFailed'));
      return;
    }

    ctx.sendResponse(requestId, { success: true, sessionId, status: 'accepted' });
  } catch (error: any) {
    ctx.sendError(requestId, 'DIFF_ACCEPT_FAILED', error.message || 'Failed to accept diff');
  }
};

/**
 * 拒绝 Diff 修改
 */
export const rejectDiff: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { sessionId } = data;
    const diffManager = getDiffManager();

    if (diffManager.isDiffActionInProgress(sessionId)) {
      ctx.sendError(requestId, 'DIFF_ALREADY_PROCESSING', t('webview.errors.diffAlreadyProcessing'));
      return;
    }

    const diff = diffManager.getDiff(sessionId);
    if (!diff || diff.status !== 'pending') {
      ctx.sendError(requestId, 'DIFF_NOT_PENDING', t('webview.errors.diffNotPending'));
      return;
    }

    const success = await diffManager.rejectDiff(sessionId);

    // 注意：这里不要调用 conversationManager.rejectToolCalls。
    // apply_diff / write_file / search_in_files(替换) 的工具执行流程会等待 diff 被 accept/reject。
    // 用户点击“Reject”应当被视为“拒绝应用修改”，而不是“拒绝执行工具”。
    // 让工具本身在收到 diffManager 状态变更后返回正确的 functionResponse（status=rejected, results 等）。

    if (!success) {
      ctx.sendError(requestId, 'DIFF_REJECT_FAILED', t('webview.errors.rejectDiffFailed'));
      return;
    }

    ctx.sendResponse(requestId, { success: true, sessionId, status: 'rejected' });
  } catch (error: any) {
    ctx.sendError(requestId, 'DIFF_REJECT_FAILED', error.message || 'Failed to reject diff');
  }
};

/**
 * 注册 Diff 处理器
 */
export function registerDiffHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('diff.openPreview', openDiffPreview);
  registry.set('diff.loadContent', loadDiffContent);
  registry.set('diff.accept', acceptDiff);
  registry.set('diff.reject', rejectDiff);
}
