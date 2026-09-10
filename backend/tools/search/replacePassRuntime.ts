import type { LockHolder } from '../../core/fileWriteLockManager';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import type { SearchMatch, SkippedFileInfo } from './searchPassRuntime';
import { normalizeLineEndingsToLF, escapeRegExp } from '../shared/textUtils';
import { createTextReader, detectTextFromHeader, decodeTextBytes, type TextDetectionResult } from './textEncodingRuntime';
import type { SearchFileHost, FileLocation } from './fileHost';
import { createSearchPass } from './searchPassRuntime';
export type { SkippedFileInfo };
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
export function createReplacePass(host: SearchFileHost) {
const {tryGetFileSizeBytes,readHeaderBytes}=createTextReader(host);
const {clampNonNegativeNumber,truncateWithEllipsis}=createSearchPass(host);
function expandReplacementTemplate(
    replacement: string,
    matchText: string,
    matchIndex: number,
    fullText: string,
    captureGroups: Array<string | undefined>,
    namedGroups?: Record<string, string | undefined>
): string {
    const preceding = fullText.slice(0, matchIndex);
    const following = fullText.slice(matchIndex + matchText.length);

    return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, ref: string) => {
        switch (ref) {
            case '$': return '$';
            case '&': return matchText;
            case '`': return preceding;
            case "'": return following;
        }

        if (ref.startsWith('<')) {
            // 命名组：存在但未参与匹配 → 空串；不存在 → 保留字面 $<name>
            const name = ref.slice(1, -1);
            if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, name)) {
                return namedGroups[name] ?? '';
            }
            return token;
        }

        // 数字引用：按规范，首数字为 0 或捕获组少于 10 时只消费一位
        const consumeOne = ref[0] === '0' || captureGroups.length < 10;
        const digits = consumeOne ? ref[0] : ref;
        const rest = consumeOne && ref.length > 1 ? ref.slice(1) : '';
        const n = Number(digits);
        if (n === 0 || n > captureGroups.length) {
            return `$${digits}${rest}`;
        }
        return (captureGroups[n - 1] ?? '') + rest;
    });
}

const MAX_REPLACE_MATCHES = 20000;

async function searchAndReplaceInDirectory(
    searchRoot: FileLocation,
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
    
    
    const findLimit = Math.max(1, Math.floor(clampNonNegativeNumber(config.maxFindFiles, 1000)));
    const foundFiles = await host.findFiles(searchRoot, filePattern, excludePattern, findLimit + 1);
    const filesTruncated = foundFiles.length > findLimit;
    const files = filesTruncated ? foundFiles.slice(0, findLimit) : foundFiles;

    const enableHeaderTextCheck = config.enableHeaderTextCheck !== false;
    const headerSampleBytes = Math.max(64, clampNonNegativeNumber(config.headerSampleBytes, 4096));
    const maxReplaceFileSizeBytes = clampNonNegativeNumber(config.maxReplaceFileSizeBytes, 1 * 1024 * 1024);
    const maxMatchPreviewChars = Math.floor(clampNonNegativeNumber(config.maxMatchPreviewChars, 220));
    
    let processedFiles = 0;
    
    
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
                        file: host.toRelativePath(fileUri, workspaceName !== null),
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

            const content = await host.readFile(fileUri);
            const originalText = normalizeLineEndingsToLF(decodeTextBytes(content, detection));
            const lines = originalText.split('\n');
            
            // 检查是否有匹配
            searchRegex.lastIndex = 0;
            if (!searchRegex.test(originalText)) {
                continue;
            }
            
            processedFiles++;
            
            // 使用支持多工作区的相对路径
            const relativePath = host.toRelativePath(fileUri, workspaceName !== null);
            
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
            // 实际内容发生变化的替换数（发现 06）：逐匹配展开替换模板比对原文，
            // “替换文本与原文相同”的无变化匹配不计入，与 filesModified 语义一致。
            let fileChangedReplacementCount = 0;
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

                // 计数用展开：与下方实际执行的 String.prototype.replace 使用同一 replacement，
                // 展开结果与原文一致说明该匹配不会产生任何内容变化。
                const expanded = expandReplacementTemplate(
                    replacement,
                    rawMatchText,
                    match.index,
                    originalText,
                    match.slice(1) as Array<string | undefined>,
                    match.groups as Record<string, string | undefined> | undefined
                );
                if (expanded !== rawMatchText) {
                    fileChangedReplacementCount++;
                }

                // 防止空匹配导致死循环
                if (rawMatchText.length === 0) {
                    searchRegex.lastIndex++;
                }
            }
            
            // 执行替换
            searchRegex.lastIndex = 0;
            const newText = originalText.replace(searchRegex, replacement);
            
            if (newText !== originalText) {
                totalReplacements += fileChangedReplacementCount;

                // 使用 DiffManager 创建待审阅的 diff
                const newContentLines = newText.split('\n').length;
                const blocks = [{
                    index: 0,
                    startLine: 1,
                    endLine: newContentLines
                }];

                const outcome = await host.review({filePath: relativePath, absolutePath: fileUri.fsPath, originalContent: originalText, newContent: newText, blocks, toolId, conversationId, abortSignal, checkpointReady, lockHolder});

                // 修改原因：waitForDiffResolution 的 'rejected'（用户拒绝了该文件的 diff，含被
                //           FIFO 淘汰后留痕的拒绝）只影响当前文件，不应把整个 replace 工具标记为
                //           cancelled；只有 'abort'（AbortSignal 中止）/ 'user'（用户中断）才是真取消。
                // 修改方式：仅真取消置 cancelledBySignal，用户拒绝保持 per-file rejected 状态。
                if (outcome.wasInterrupted) {
                    cancelledBySignal = true;
                }

                // 取消/中断视为 rejected，避免前端继续显示 waiting
                const status: 'accepted' | 'rejected' = outcome.wasAccepted ? 'accepted' : 'rejected';

                replacements.push({
                    file: relativePath,
                    workspace: workspaceName || undefined,
                    replacements: fileChangedReplacementCount,
                    status,
                    diffContentId: outcome.diffContentId,
                    autoSaveError: outcome.autoSaveError,
                    pendingDiffId: outcome.pendingDiffId
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
                file: host.toRelativePath(fileUri, workspaceName !== null),
                reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}`
            });
        }
    }
    
    return { matches, replacements, totalReplacements, processedFiles, skippedFiles, cancelled: cancelledBySignal, truncated: matchesTruncated || filesTruncated };
}

return {expandReplacementTemplate,MAX_REPLACE_MATCHES,searchAndReplaceInDirectory};
}
