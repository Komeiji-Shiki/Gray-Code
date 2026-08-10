/**
 * search_in_files 替换遍历（模块化拆分）
 *
 * 替换模式（mode=replace）的目录遍历、匹配收集与替换执行，
 * 通过 DiffManager 创建待审阅的 diff。
 */

import * as vscode from 'vscode';
import { toRelativePath, normalizeLineEndingsToLF } from '../utils';
import { getDiffStorageManager } from '../../modules/conversation';
import { getDiffManager } from '../file/diffManager';
import type { LockHolder } from '../../core/fileWriteLockManager';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import {
    tryGetFileSizeBytes,
    readHeaderBytes,
    detectTextFromHeader,
    decodeTextBytes
} from './textEncoding';
import type { TextDetectionResult } from './textEncoding';
import { clampNonNegativeNumber, truncateWithEllipsis } from './searchPass';
import type { SearchMatch } from './searchPass';

/**
 * 替换模式 matches 收集预算上限：防止 maxFiles×高频 query 产生数百万条匹配全量回传
 */
export const MAX_REPLACE_MATCHES = 20000;

/**
 * 替换结果
 */
export interface ReplaceResult {
    file: string;
    workspace?: string;
    replacements: number;
    status?: 'accepted' | 'rejected' | 'pending';
    diffContentId?: string;
    /** 自动保存失败原因；用于让 search/replace 的文件级结果解释 rejected 的真实原因 */
    autoSaveError?: string;
    /** Pending diff ID，用于确认/拒绝 */
    pendingDiffId?: string;
}

/**
 * 在单个目录中搜索并替换
 * 使用 DiffManager 创建待审阅的 diff
 */
/**
 * 替换模式下被跳过的文件及原因。
 *
 * 为什么需要：以前文件处理异常被静默吞掉，模型看到的结果是
 * “这个文件没有匹配”，实际是“处理失败”，导致结果与现实对不上。
 */
export interface SkippedFileInfo {
    file: string;
    reason: string;
}

export async function searchAndReplaceInDirectory(
    searchRoot: vscode.Uri,
    filePattern: string,
    searchRegexInput: RegExp,
    replacement: string,
    maxFiles: number,
    workspaceName: string | null,
    excludePattern: string,
    config: Readonly<SearchInFilesToolConfig>,
    toolId?: string,
    abortSignal?: AbortSignal,
    conversationId?: string,
    checkpointReady?: Promise<unknown>,
    lockHolder?: LockHolder
): Promise<{
    matches: SearchMatch[];
    replacements: ReplaceResult[];
    totalReplacements: number;
    processedFiles: number;
    skippedFiles: SkippedFileInfo[];
    cancelled: boolean;
    truncated: boolean;
}> {
    // 本地克隆，理由同 searchInDirectory：隔离 g 标志正则的 lastIndex 状态
    const searchRegex = new RegExp(searchRegexInput.source, searchRegexInput.flags);
    const matches: SearchMatch[] = [];
    const replacements: ReplaceResult[] = [];
    const skippedFiles: SkippedFileInfo[] = [];
    let totalReplacements = 0;
    let cancelledBySignal = false;
    // matches 仅用于向模型报告匹配位置，maxFiles×高频 query 可产生数百万条；
    // 加预算上限防止 data.matches 全量回传导致内存与响应体爆炸（替换本身不受影响）
    let matchesTruncated = false;
    
    const pattern = new vscode.RelativePattern(searchRoot, filePattern);
    const findLimit = Math.max(1, Math.floor(clampNonNegativeNumber(config.maxFindFiles, 1000)));
    const foundFiles = await vscode.workspace.findFiles(pattern, excludePattern, findLimit + 1);
    const filesTruncated = foundFiles.length > findLimit;
    const files = filesTruncated ? foundFiles.slice(0, findLimit) : foundFiles;

    const enableHeaderTextCheck = config.enableHeaderTextCheck !== false;
    const headerSampleBytes = Math.max(64, clampNonNegativeNumber(config.headerSampleBytes, 4096));
    const maxReplaceFileSizeBytes = clampNonNegativeNumber(config.maxReplaceFileSizeBytes, 1 * 1024 * 1024);
    const maxMatchPreviewChars = Math.floor(clampNonNegativeNumber(config.maxMatchPreviewChars, 220));
    
    let processedFiles = 0;
    const diffManager = getDiffManager();
    
    for (const fileUri of files) {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            cancelledBySignal = true;
            break;
        }

        if (processedFiles >= maxFiles) {
            break;
        }
        
        try {
            // 文件大小护栏（替换模式更保守，避免生成超大 diff）
            if (maxReplaceFileSizeBytes > 0) {
                const size = await tryGetFileSizeBytes(fileUri);
                if (typeof size === 'number' && size > maxReplaceFileSizeBytes) {
                    skippedFiles.push({
                        file: toRelativePath(fileUri, workspaceName !== null),
                        reason: `File exceeds the replace-mode size limit (${size} > ${maxReplaceFileSizeBytes} bytes)`
                    });
                    continue;
                }
            }

            // 文件头文本检测（跳过二进制）
            let detection: TextDetectionResult = { isText: true, encoding: 'utf-8', bomLength: 0 };
            if (enableHeaderTextCheck) {
                try {
                    const header = await readHeaderBytes(fileUri, headerSampleBytes);
                    detection = detectTextFromHeader(header);
                    if (!detection.isText) {
                        continue;
                    }
                } catch {
                    detection = { isText: true, encoding: 'utf-8', bomLength: 0 };
                }
            }

            const content = await vscode.workspace.fs.readFile(fileUri);
            const originalText = normalizeLineEndingsToLF(decodeTextBytes(content, detection));
            const lines = originalText.split('\n');
            
            // 检查是否有匹配
            searchRegex.lastIndex = 0;
            if (!searchRegex.test(originalText)) {
                continue;
            }
            
            processedFiles++;
            
            // 使用支持多工作区的相对路径
            const relativePath = toRelativePath(fileUri, workspaceName !== null);
            
            // 收集该文件的匹配信息
            //
            // 重要：必须在全文上匹配（而非逐行），与下方实际执行替换的
            // originalText.replace(searchRegex, ...) 保持完全一致的语义。
            // 否则跨行正则（如 foo[\s\S]*?bar）会出现“报告 0 匹配但实际已替换”的误导结果。
            // 行号/列号通过行起始偏移二分换算。
            const lineOffsets: number[] = new Array(lines.length);
            {
                let offset = 0;
                for (let i = 0; i < lines.length; i++) {
                    lineOffsets[i] = offset;
                    offset += lines[i].length + 1; // +1 为换行符（已统一为 LF）
                }
            }
            const offsetToLineCol = (index: number): { line: number; column: number } => {
                let lo = 0;
                let hi = lineOffsets.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (lineOffsets[mid] <= index) {
                        lo = mid;
                    } else {
                        hi = mid - 1;
                    }
                }
                return { line: lo + 1, column: index - lineOffsets[lo] + 1 };
            };

            let fileReplacementCount = 0;
            let match;
            searchRegex.lastIndex = 0;

            while ((match = searchRegex.exec(originalText)) !== null) {
                const rawMatchText = match[0] ?? '';
                if (matches.length < MAX_REPLACE_MATCHES) {
                    const matchText = rawMatchText.length > maxMatchPreviewChars
                        ? truncateWithEllipsis(rawMatchText, maxMatchPreviewChars)
                        : rawMatchText;
                    const pos = offsetToLineCol(match.index);

                    matches.push({
                        file: relativePath,
                        workspace: workspaceName || undefined,
                        line: pos.line,
                        column: pos.column,
                        match: matchText,
                        // 替换模式下不会在返回体中使用 context，这里置空避免无谓的字符串拼接
                        context: ''
                    });
                } else {
                    // 达到收集预算上限：停止收集匹配，但继续计数与执行替换
                    matchesTruncated = true;
                }

                fileReplacementCount++;

                // 防止空匹配导致死循环
                if (rawMatchText.length === 0) {
                    searchRegex.lastIndex++;
                }
            }
            
            // 执行替换
            searchRegex.lastIndex = 0;
            const newText = originalText.replace(searchRegex, replacement);
            
            if (newText !== originalText) {
                totalReplacements += fileReplacementCount;
                
                let diffContentId: string | undefined;
                let status: 'accepted' | 'rejected' | 'pending' = 'pending';
                let pendingDiffId: string | undefined;

                // 使用 DiffManager 创建待审阅的 diff
                const newContentLines = newText.split('\n').length;
                const blocks = [{
                    index: 0,
                    startLine: 1,
                    endLine: newContentLines
                }];

                const pendingDiff = await diffManager.createPendingDiff(
                    relativePath,
                    fileUri.fsPath,
                    originalText,
                    newText,
                    blocks,
                    undefined,
                    toolId,
                    {
                        conversationId,
                        // checkpoint 写盘屏障 + 写盘锁持有者身份：与 write_file/apply_diff 一致，
                        // 替换模式同样参与 checkpoint 写盘屏障（M9）
                        checkpointReady,
                        lockHolder
                    }
                );

                const interruptReason = await diffManager.waitForDiffResolution(pendingDiff.id, abortSignal);

                // 修改原因：waitForDiffResolution 的 'rejected'（用户拒绝了该文件的 diff，含被
                //           FIFO 淘汰后留痕的拒绝）只影响当前文件，不应把整个 replace 工具标记为
                //           cancelled；只有 'abort'（AbortSignal 中止）/ 'user'（用户中断）才是真取消。
                // 修改方式：仅真取消置 cancelledBySignal，用户拒绝保持 per-file rejected 状态。
                const wasAborted = interruptReason === 'abort' || interruptReason === 'user';
                if (wasAborted) {
                    cancelledBySignal = true;
                }

                const finalDiff = diffManager.getDiff(pendingDiff.id);
                // 由 waitForDiffResolution 的终态语义判定：'rejected'（含被 FIFO 淘汰后留痕的拒绝）
                // 一律不算接受，避免被拒绝的 diff 被淘汰后 !finalDiff 误报"替换成功"。
                const wasAccepted = interruptReason === 'none';
                const autoSaveError = finalDiff?.autoSaveError;

                // 取消/中断视为 rejected，避免前端继续显示 waiting
                status = wasAccepted ? 'accepted' : 'rejected';
                pendingDiffId = undefined;

                // 保存 diff 内容用于前端显示
                const diffStorageManager = getDiffStorageManager();
                if (diffStorageManager) {
                    try {
                        const diffRef = await diffStorageManager.saveGlobalDiff({
                            originalContent: originalText,
                            newContent: newText,
                            filePath: relativePath
                        });
                        diffContentId = diffRef.diffId;
                    } catch (e) {
                        console.warn('Failed to save diff content:', e);
                    }
                }
                
                replacements.push({
                    file: relativePath,
                    workspace: workspaceName || undefined,
                    replacements: fileReplacementCount,
                    status,
                    diffContentId,
                    autoSaveError,
                    pendingDiffId
                });
            } else if (fileReplacementCount > 0) {
                // 有匹配但替换后内容无变化（替换文本与原文相同），
                // 明确告知而不是让 matches 与 filesModified 矛盾得让模型困惑
                skippedFiles.push({
                    file: relativePath,
                    reason: `Matched ${fileReplacementCount} time(s) but the replacement produced no changes (replacement text equals the original)`
                });
            }
        } catch (e) {
            // 文件处理失败不再静默吞掉，记录原因让模型能区分“没匹配”和“处理失败”
            skippedFiles.push({
                file: toRelativePath(fileUri, workspaceName !== null),
                reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}`
            });
        }
    }
    
    return { matches, replacements, totalReplacements, processedFiles, skippedFiles, cancelled: cancelledBySignal, truncated: matchesTruncated || filesTruncated };
}
