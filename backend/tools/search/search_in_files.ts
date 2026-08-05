/**
 * 在文件中搜索（和替换）内容工具
 *
 * 支持多工作区（Multi-root Workspaces）
 * 支持正则表达式搜索和替换
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { Tool, ToolResult } from '../types';
import {
    getWorkspaceRoot,
    getAllWorkspaces,
    getWorkspaceByUri,
    parseWorkspacePath,
    toRelativePath,
    normalizeLineEndingsToLF,
    escapeRegExp,
    isPathInsideOrEqualReal,
    detectSuspectedRegexIntent,
    createSuspectedRegexSuggestion,
    resolveFileToolPathWithInfo
} from '../utils';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDiffStorageManager } from '../../modules/conversation';
import { getDiffManager } from '../file/diffManager';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { validateRegexPattern } from './regexGuard';
import type { LockHolder } from '../../core/fileWriteLockManager';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';

/**
 * 默认排除模式
 */
const DEFAULT_EXCLUDE = '**/node_modules/**';

/**
 * 替换模式 matches 收集预算上限：防止 maxFiles×高频 query 产生数百万条匹配全量回传
 */
const MAX_REPLACE_MATCHES = 20000;

/**
 * 获取 search_in_files 工具配置（带默认值兜底）
 */
function getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
    const settingsManager = getGlobalSettingsManager();
    if (settingsManager) {
        return settingsManager.getSearchInFilesConfig();
    }
    return DEFAULT_SEARCH_IN_FILES_CONFIG;
}

/**
 * 获取排除模式
 *
 * 从已解析的工具配置取用户配置的排除模式，未配置时使用默认值；
 * 多个模式合并为单个 glob 模式（大括号语法）。
 * handler 直接复用本函数，避免两处重复维护相同逻辑。
 */
function getExcludePattern(config: Readonly<SearchInFilesToolConfig>): string {
    if (config.excludePatterns && config.excludePatterns.length > 0) {
        // 多个模式用 {} 语法组合
        if (config.excludePatterns.length === 1) {
            return config.excludePatterns[0];
        }
        return `{${config.excludePatterns.join(',')}}`;
    }
    return DEFAULT_EXCLUDE;
}

function splitWhitespaceFallbackKeywords(query: string): string[] {
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const rawKeyword of query.trim().split(/\s+/)) {
        const keyword = rawKeyword.trim();
        if (!keyword) continue;

        const dedupeKey = keyword.toLocaleLowerCase();
        if (seen.has(dedupeKey)) continue;

        seen.add(dedupeKey);
        keywords.push(keyword);
    }

    return keywords.length > 1 ? keywords : [];
}

function createFallbackKeywordRegex(keywords: string[], flags: string): RegExp {
    return new RegExp(keywords.map(escapeRegExp).join('|'), flags);
}

/**
 * 搜索匹配项
 */
interface SearchMatch {
    file: string;
    workspace?: string;
    line: number;
    column: number;
    match: string;
    context: string;
}

/**
 * 替换结果
 */
interface ReplaceResult {
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

// ==================== 二进制/文本检测与输出裁剪辅助 ====================

type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

interface TextDetectionResult {
    isText: boolean;
    encoding: TextEncoding;
    /** BOM 字节数（需要跳过） */
    bomLength: number;
    reason?: string;
}

interface SearchBudget {
    remainingChars: number;
    truncated: boolean;
}

interface SearchPassResult {
    results: SearchMatch[];
    budgetTruncated: boolean;
}

interface SearchQueryFallbackInfo {
    applied: boolean;
    originalQuery: string;
    keywords: string[];
    reason?: 'whitespace_keyword_or' | 'suspected_regex';
    suggestion?: string;
    signals?: string[];
}

interface SearchPathWarningInfo {
    type: 'possible_multiple_paths';
    path: string;
    candidates: string[];
    message: string;
}

function clampNonNegativeNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return value < 0 ? 0 : value;
}

async function tryGetFileSizeBytes(uri: vscode.Uri): Promise<number | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return typeof stat.size === 'number' ? stat.size : undefined;
    } catch {
        return undefined;
    }
}

async function readHeaderBytes(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array> {
    const n = Math.max(0, Math.floor(maxBytes));
    if (n <= 0) {
        return new Uint8Array();
    }

    // 本地文件优先用 Node fs 做真正的“只读文件头”
    if (uri.scheme === 'file' && uri.fsPath) {
        try {
            const handle = await fs.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(n);
                const { bytesRead } = await handle.read(buffer, 0, n, 0);
                return buffer.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        } catch {
            // 回退到 vscode fs
        }
    }

    // 非 file scheme：无法保证部分读取，退化为读取后截取（有大小护栏即可）
    const content = await vscode.workspace.fs.readFile(uri);
    return content.subarray(0, Math.min(n, content.length));
}

function detectTextFromHeader(header: Uint8Array): TextDetectionResult {
    if (!header || header.length === 0) {
        return { isText: true, encoding: 'utf-8', bomLength: 0 };
    }

    // BOM 检测
    if (header.length >= 3 && header[0] === 0xEF && header[1] === 0xBB && header[2] === 0xBF) {
        return { isText: true, encoding: 'utf-8', bomLength: 3 };
    }
    if (header.length >= 2 && header[0] === 0xFF && header[1] === 0xFE) {
        return { isText: true, encoding: 'utf-16le', bomLength: 2 };
    }
    if (header.length >= 2 && header[0] === 0xFE && header[1] === 0xFF) {
        return { isText: true, encoding: 'utf-16be', bomLength: 2 };
    }

    // UTF-16（无 BOM）启发式：大量 NUL 且集中在偶/奇位
    const sampleLen = Math.min(header.length, 1024);
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            if (i % 2 === 0) evenZeros++;
            else oddZeros++;
        }
    }
    const evenCount = Math.ceil(sampleLen / 2);
    const oddCount = Math.floor(sampleLen / 2) || 1;
    const evenZeroRatio = evenZeros / (evenCount || 1);
    const oddZeroRatio = oddZeros / oddCount;

    if (oddZeroRatio > 0.3 && evenZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16le', bomLength: 0 };
    }
    if (evenZeroRatio > 0.3 && oddZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16be', bomLength: 0 };
    }

    // NUL 基本可判为二进制（非 UTF-16）
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            return { isText: false, encoding: 'utf-8', bomLength: 0, reason: 'NUL byte detected' };
        }
    }

    // 控制字符占比过高：倾向二进制
    let suspicious = 0;
    for (let i = 0; i < sampleLen; i++) {
        const b = header[i];
        const isAllowedWhitespace = b === 0x09 || b === 0x0A || b === 0x0D; // \t \n \r
        const isControl =
            (b < 0x20 && !isAllowedWhitespace) ||
            b === 0x7F;
        if (isControl) suspicious++;
    }
    const suspiciousRatio = suspicious / (sampleLen || 1);
    if (suspiciousRatio > 0.3) {
        return { isText: false, encoding: 'utf-8', bomLength: 0, reason: `High control-char ratio: ${suspiciousRatio.toFixed(2)}` };
    }

    return { isText: true, encoding: 'utf-8', bomLength: 0 };
}

function swapByteOrder16(data: Uint8Array): Uint8Array {
    const len = data.length - (data.length % 2);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 2) {
        out[i] = data[i + 1];
        out[i + 1] = data[i];
    }
    return out;
}

function decodeTextBytes(bytes: Uint8Array, detection: TextDetectionResult): string {
    const start = Math.max(0, detection.bomLength || 0);
    const sliced = bytes.subarray(start);

    if (detection.encoding === 'utf-16be') {
        const swapped = swapByteOrder16(sliced);
        return new TextDecoder('utf-16le').decode(swapped);
    }

    if (detection.encoding === 'utf-16le') {
        return new TextDecoder('utf-16le').decode(sliced);
    }

    return new TextDecoder('utf-8').decode(sliced);
}

function truncateWithEllipsis(text: string, maxChars: number): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit <= 0) {
        return '';
    }
    if (text.length <= limit) {
        return text;
    }
    // 留一个字符给省略号
    const sliceLen = Math.max(0, limit - 1);
    return `${text.slice(0, sliceLen)}…`;
}

function createMatchLineSnippet(line: string, matchStart: number, matchLength: number, maxChars: number): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit <= 0) {
        return '';
    }
    if (line.length <= limit) {
        return line;
    }

    const start = Math.max(0, matchStart);
    const end = Math.max(start, start + Math.max(0, matchLength));

    // 让窗口尽量把 match 放在中间
    const half = Math.floor(limit / 2);
    let windowStart = Math.max(0, start - half);
    let windowEnd = windowStart + limit;
    if (windowEnd < end) {
        windowEnd = Math.min(line.length, end + half);
        windowStart = Math.max(0, windowEnd - limit);
    }
    if (windowEnd > line.length) {
        windowEnd = line.length;
        windowStart = Math.max(0, windowEnd - limit);
    }

    let snippet = line.slice(windowStart, windowEnd);
    if (windowStart > 0) {
        snippet = `…${snippet}`;
    }
    if (windowEnd < line.length) {
        snippet = `${snippet}…`;
    }
    return snippet;
}

function estimateMatchCost(relativePath: string, matchText: string, context: string): number {
    // 近似预算：路径 + match + context + 结构开销
    return (relativePath?.length || 0) + (matchText?.length || 0) + (context?.length || 0) + 80;
}

/**
 * 在单个目录中搜索（仅搜索，不替换）
 */
async function searchInDirectory(
    searchRoot: vscode.Uri,
    filePattern: string,
    searchRegexInput: RegExp,
    maxResults: number,
    workspaceName: string | null,
    excludePattern: string,
    config: Readonly<SearchInFilesToolConfig>,
    budget?: SearchBudget
): Promise<SearchMatch[]> {
    // 本地克隆：g 标志正则携带可变 lastIndex 状态，共享实例跨函数/跨循环传递
    // 全靠每处使用前手动重置，极其脆弱；克隆后状态完全局限在本函数内。
    const searchRegex = new RegExp(searchRegexInput.source, searchRegexInput.flags);
    const results: SearchMatch[] = [];
    
    const pattern = new vscode.RelativePattern(searchRoot, filePattern);
    const files = await vscode.workspace.findFiles(pattern, excludePattern, 1000);

    const enableHeaderTextCheck = config.enableHeaderTextCheck !== false;
    const headerSampleBytes = Math.max(64, clampNonNegativeNumber(config.headerSampleBytes, 4096));
    const maxFileSizeBytes = clampNonNegativeNumber(config.maxFileSizeBytes, 5 * 1024 * 1024);
    const contextBefore = Math.floor(clampNonNegativeNumber(config.contextLinesBefore, 1));
    const contextAfter = Math.floor(clampNonNegativeNumber(config.contextLinesAfter, 1));
    const maxLinePreviewChars = Math.floor(clampNonNegativeNumber(config.maxLinePreviewChars, 300));
    const maxMatchPreviewChars = Math.floor(clampNonNegativeNumber(config.maxMatchPreviewChars, 220));
    
    for (const fileUri of files) {
        if (results.length >= maxResults) {
            break;
        }
        if (budget && budget.remainingChars <= 0) {
            budget.truncated = true;
            break;
        }
        
        try {
            // 文件大小护栏（避免读入超大文件）
            if (maxFileSizeBytes > 0) {
                const size = await tryGetFileSizeBytes(fileUri);
                if (typeof size === 'number' && size > maxFileSizeBytes) {
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
                    // header 检测失败时退化为旧行为（仍有大小/输出护栏）
                    detection = { isText: true, encoding: 'utf-8', bomLength: 0 };
                }
            }

            const content = await vscode.workspace.fs.readFile(fileUri);
            const text = normalizeLineEndingsToLF(decodeTextBytes(content, detection));
            const lines = text.split('\n');

            // 使用支持多工作区的相对路径（每文件只计算一次）
            const relativePath = toRelativePath(fileUri, workspaceName !== null);
            
            for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) {
                    break;
                }
                if (budget && budget.remainingChars <= 0) {
                    budget.truncated = true;
                    break;
                }
                
                const line = lines[i];
                let match;
                searchRegex.lastIndex = 0;
                
                while ((match = searchRegex.exec(line)) !== null) {
                    if (results.length >= maxResults) {
                        break;
                    }
                    if (budget && budget.remainingChars <= 0) {
                        budget.truncated = true;
                        break;
                    }
                    
                    const rawMatchText = match[0] ?? '';
                    const matchText = rawMatchText.length > maxMatchPreviewChars
                        ? truncateWithEllipsis(rawMatchText, maxMatchPreviewChars)
                        : rawMatchText;

                    // 获取上下文（可配置行数，且对超长行做裁剪）
                    const contextLines: string[] = [];

                    const beforeStart = Math.max(0, i - contextBefore);
                    for (let j = beforeStart; j < i; j++) {
                        contextLines.push(`${j + 1}: ${truncateWithEllipsis(lines[j], maxLinePreviewChars)}`);
                    }

                    const matchLinePreview = createMatchLineSnippet(line, match.index ?? 0, rawMatchText.length, maxMatchPreviewChars);
                    contextLines.push(`${i + 1}: ${matchLinePreview}`);

                    const afterEnd = Math.min(lines.length - 1, i + contextAfter);
                    for (let j = i + 1; j <= afterEnd; j++) {
                        contextLines.push(`${j + 1}: ${truncateWithEllipsis(lines[j], maxLinePreviewChars)}`);
                    }

                    const context = contextLines.join('\n');

                    // 输出预算护栏
                    const cost = estimateMatchCost(relativePath, matchText, context);
                    if (budget && budget.remainingChars - cost < 0) {
                        budget.truncated = true;
                        break;
                    }
                    
                    results.push({
                        file: relativePath,
                        workspace: workspaceName || undefined,
                        line: i + 1,
                        column: match.index + 1,
                        match: matchText,
                        context
                    });

                    if (budget) {
                        budget.remainingChars -= cost;
                    }

                    // 防止空匹配导致死循环
                    if ((match[0] ?? '').length === 0) {
                        searchRegex.lastIndex++;
                    }
                }
            }
        } catch {
            // 跳过无法读取的文件
        }
    }
    
    return results;
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
interface SkippedFileInfo {
    file: string;
    reason: string;
}

async function searchAndReplaceInDirectory(
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
    const files = await vscode.workspace.findFiles(pattern, excludePattern, 1000);

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

                const wasInterrupted = interruptReason !== 'none';
                if (wasInterrupted) {
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
    
    return { matches, replacements, totalReplacements, processedFiles, skippedFiles, cancelled: cancelledBySignal, truncated: matchesTruncated };
}

/**
 * 根据 workspace 根和相对路径，判断是目录还是单个文件，并返回合适的搜索根和文件匹配模式。
 *
 * 使用约定：
 * - 目录 path 末尾应带有 "/"（例如 "src/" 或 "workspace_name/src/"）。
 * - 文件 path 不带末尾斜杠（例如 "src/index.ts"）。
 *
 * 实现上仍会通过 fs.stat 精确判断文件/目录，但在工具定义中会提示 AI 使用上述约定，
 * 以减少歧义。
 *
 * - 如果 relativePath 指向一个存在的文件，则：
 *   - searchRoot 为该文件所在的目录；
 *   - effectivePattern 为该文件名（只搜索这一文件）。
 * - 其它情况按目录处理：
 *   - searchRoot = rootUri + relativePath；
 *   - effectivePattern = 原始 filePattern。
 */
async function getSearchRootAndPattern(
    rootUri: vscode.Uri,
    relativePath: string,
    filePattern: string
): Promise<{ searchRoot: vscode.Uri; effectivePattern: string }> {
    // 空路径或当前目录，直接用 workspace 根目录
    if (!relativePath || relativePath === '.' || relativePath === './') {
        return { searchRoot: rootUri, effectivePattern: filePattern };
    }

    const fullUri = vscode.Uri.joinPath(rootUri, relativePath);

    // 路径安全防线：joinPath 会规范化 `..` 段，导致 `../` 解析到工作区外。
    // 这里对解析结果做（符号链接感知的）包含性校验，越界直接拒绝，
    // 防止搜索/替换作用到工作区之外。
    if (!isPathInsideOrEqualReal(fullUri.fsPath, rootUri.fsPath)) {
        throw new Error(`Search path escapes the workspace: ${relativePath}`);
    }

    try {
        const stat = await vscode.workspace.fs.stat(fullUri);
        if (stat.type === vscode.FileType.File) {
            // 是单个文件：搜索根为所在目录，pattern 为文件名
            const fsPath = fullUri.fsPath;
            const dirPath = path.dirname(fsPath);
            const fileName = path.basename(fsPath);
            return {
                searchRoot: vscode.Uri.file(dirPath),
                effectivePattern: fileName

            };
        }
    } catch {
        // stat 失败（路径不存在或权限问题），按目录处理
    }

    // 默认按目录处理
    return {
        searchRoot: fullUri,
        effectivePattern: filePattern
    };
}

/**
 * 工作区外访问策略自检（H3）。
 *
 * 为什么需要：search_in_files 的 path 参数可以是目录/文件绝对路径，
 * 解析出 searchRoot 后若位于工作区外，必须与 read_file/write_file 一样受外部访问策略管控。
 * 除了 ToolExecutionService 的统一拦截（白名单 + path 提取），这里在 handler 内再兜底一次，
 * 覆盖子代理/直调工具链路等绕过服务层的执行路径。
 * search 模式沿用读策略（deny/ask/allow），replace 模式沿用写策略（deny/ask）。
 */
function getSearchRootAccessError(
    searchRoot: vscode.Uri,
    args: Record<string, unknown>,
    context?: import('../types').ToolContext
): string | null {
    const info = resolveFileToolPathWithInfo(searchRoot.fsPath, context?.activeWorkspaceUri);
    if (!info.isOutsideWorkspace) {
        return null;
    }
    return ensureOutsideWorkspaceAccessApproved(
        'search_in_files',
        { path: searchRoot.fsPath, mode: args.mode },
        context
    );
}

/**
 * 工作区外访问被策略拒绝/需要确认时抛出，由 handler 顶层捕获并直接透传可读错误
 *（与 read_file 返回的访问错误信息保持一致，不额外包装 "Search failed:" 前缀）。
 */
class OutsideWorkspaceAccessError extends Error {}

function createPossibleMultiplePathsWarning(searchPath: string): SearchPathWarningInfo | undefined {
    const normalized = (searchPath || '').trim();
    if (!normalized || normalized === '.') {
        return undefined;
    }

    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
        return undefined;
    }

    const pathLikeParts = parts.filter(part => part.includes('/') || part.includes('\\') || part.startsWith('@'));
    if (pathLikeParts.length < 2) {
        return undefined;
    }

    return {
        type: 'possible_multiple_paths',
        path: searchPath,
        candidates: parts,
        message: `The path parameter accepts exactly one file or directory. The supplied path looks like multiple whitespace-separated paths (${parts.join(', ')}). Run separate parallel search_in_files calls for each path instead of putting them in one path string.`
    };
}

/**
 * 创建搜索文件内容工具
 */
export function createSearchInFilesTool(): Tool {
    // 获取工作区信息用于描述
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    let pathDescription = 'Search path relative to workspace root. Use "dir/" (trailing slash) for directories, or "dir/file.ext" for a single file. Default "." searches the entire workspace.';
    if (isMultiRoot) {
        pathDescription = `Search path, use "workspace_name/path" format. Use "workspace_name/dir/" (trailing slash) for directories, or "workspace_name/file.ext" for a single file. Use "." to search all workspaces. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }
    
    return {
        declaration: {
            name: 'search_in_files',
            strict: true,  // API 端强制 schema 校验
            description: isMultiRoot
                ? `Search or search-and-replace content in multiple workspace files. Supports regular expressions. Use "workspace_name/dir/" (trailing slash) for directories, or "workspace_name/file.ext" for a single file. Use "." to search all workspaces. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`
                : 'Search or search-and-replace content in workspace files. Supports regular expressions. Use "dir/" (trailing slash) for directories, or "dir/file.ext" for a single file. Returns matching files and context.',
            category: 'search',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['search', 'replace'],
                        description: 'Operation mode. Use "search" for finding content only, use "replace" for search and replace.',
                        default: 'search'
                    },
                    query: {
                        type: 'string',
                        description: 'Search keyword, exact phrase, space-separated keywords, or regular expression. If query contains regex syntax such as "|", ".*", ".+", "\\.", "\\d", "[]", "()", "^", or "$", set isRegex=true. Search mode first tries the full literal phrase and may retry space-separated keywords when isRegex=false.'
                    },
                    path: {
                        type: 'string',
                        description: pathDescription,
                        default: '.'
                    },
                    pattern: {
                        type: 'string',
                        description: 'File matching pattern, e.g., "*.ts" or "**/*.js"',
                        default: '**/*'
                    },
                    isRegex: {
                        type: 'boolean',
                        description: 'Whether to treat query as a regular expression. Default: false. When false, regex-looking characters are searched literally; zero-result searches may return suspected_regex diagnostics instead of silently changing semantics.',
                        default: false
                    },
                    caseSensitive: {
                        type: 'boolean',
                        description: 'Whether matching is case-sensitive. Defaults differ by mode: search mode defaults to false (case-insensitive), replace mode defaults to true (conservative exact replacement). Pass explicitly to override, e.g. set caseSensitive=false in replace mode to replace matches found by a case-insensitive search.'
                    },
                    maxResults: {
                        type: 'number',
                        description: '[Search mode] Maximum number of match results',
                        default: 100
                    },
                    replace: {
                        type: 'string',
                        description: '[Replace mode] Replacement string. REQUIRED when mode is "replace"; omitting it would silently replace all matches with empty string. Supports regex capture groups like $1, $2 when isRegex is true.'
                    },
                    maxFiles: {
                        type: 'number',
                        description: '[Replace mode] Maximum number of files to process',
                        default: 50
                    }
                },
                required: ['query']
            }
        },
        handler: async (args, context?: import('../types').ToolContext): Promise<ToolResult> => {
            const query = args.query as string;
            const searchPath = (args.path as string) || '.';
            const filePattern = (args.pattern as string) || '**/*';
            const isRegex = (args.isRegex as boolean) || false;
            
            // 严格按照 mode 字段决定模式，忽略其他不相关的参数
            const mode = (args.mode as string) || 'search';
            const isReplaceMode = mode === 'replace';

            // replace 模式下 replace 参数必须显式提供：漏传时替换串为空会静默删除所有匹配内容
            if (isReplaceMode && typeof args.replace !== 'string') {
                return {
                    success: false,
                    error: 'replace parameter is required when mode is "replace"'
                };
            }

            // 大小写语义：search 默认不区分（方便定位），replace 默认区分（保守替换）。
            // 支持显式覆盖，并在 0 命中时通过诊断信息提醒模型两种模式的默认差异，
            // 避免“search 搜得到、replace 替不了”的困惑。
            const caseSensitive = typeof args.caseSensitive === 'boolean'
                ? (args.caseSensitive as boolean)
                : isReplaceMode;
            
            // 搜索模式参数
            const maxResults = (args.maxResults as number) || 100;
            
            // 替换模式参数（仅在替换模式下使用）。
            // isRegex=false 时 query 按字面量匹配，替换串也必须按字面量写入：
            // 转义 $ 序列，防止 $&/$1/$$ 被 String.replace 解释为特殊替换模式
            //（工具描述承诺捕获组仅在 isRegex=true 时生效）。
            const rawReplacement = isReplaceMode ? ((args.replace as string) ?? '') : '';
            const replacement = isReplaceMode && !isRegex
                ? rawReplacement.replace(/\$/g, '$$$$')
                : rawReplacement;
            const maxFiles = isReplaceMode ? ((args.maxFiles as number) || 50) : 50;

            if (!query) {
                return { success: false, error: 'query is required' };
            }

            const workspaces = getAllWorkspaces();
            if (workspaces.length === 0) {
                return { success: false, error: 'No workspace folder open' };
            }

            // 多工作区支持：会话绑定工作区时（未显式指定前缀的搜索），搜索范围收敛到该工作区
            let searchWorkspaces = workspaces;
            if (context?.activeWorkspaceUri && workspaces.length > 1) {
                const preferred = getWorkspaceByUri(context.activeWorkspaceUri);
                if (preferred) {
                    searchWorkspaces = [preferred];
                }
            }

            try {
                // 创建搜索正则表达式（均为全局匹配）
                // search 模式额外启用多行标志 m；大小写由 caseSensitive 控制
                const flags = (isReplaceMode ? 'g' : 'gm') + (caseSensitive ? '' : 'i');
                // ReDoS 防护：长度上限 + 嵌套量词危险模式检测 + 构造异常捕获（共享 regexGuard），
                // 避免灾难性回溯阻塞扩展宿主
                const regexSource = isRegex ? query : escapeRegExp(query);
                const guardedRegex = validateRegexPattern(regexSource, flags);
                if (!guardedRegex.ok) {
                    return {
                        success: false,
                        error: guardedRegex.error
                    };
                }
                const searchRegex = guardedRegex.regex;
                
                // 获取配置与排除模式
                const searchConfig = getSearchInFilesConfig();
                const excludePattern = getExcludePattern(searchConfig);
                
                // 解析路径，确定搜索范围
                const parsedPath = parseWorkspacePath(searchPath, context?.activeWorkspaceUri);
                const { workspace: targetWorkspace, relativePath, isExplicit } = parsedPath;
                const pathWarning = createPossibleMultiplePathsWarning(searchPath);

                // 多根工作区下未带前缀/未知前缀的 path 解析失败时，不再静默回退到第一个工作区，
                // 直接把解析错误透传给模型；'.' 表示搜索所有工作区，是文档化的例外
                if (parsedPath.error && !(searchPath === '.' && workspaces.length > 1)) {
                    return { success: false, error: parsedPath.error };
                }
                
                if (isReplaceMode) {
                    // 替换模式
                    let allMatches: SearchMatch[] = [];
                    let allReplacements: ReplaceResult[] = [];
                    let allSkippedFiles: SkippedFileInfo[] = [];
                    let totalReplacements = 0;
                    let anyCancelled = false;
                    let anyTruncated = false;
                    
                    if (isExplicit && targetWorkspace) {
                        // 显式指定了工作区，只搜索该工作区
                        const { searchRoot, effectivePattern } = await getSearchRootAndPattern(
                            targetWorkspace.uri,
                            relativePath,
                            filePattern
                        );
                        const accessError = getSearchRootAccessError(searchRoot, args, context);
                        if (accessError) {
                            return { success: false, error: accessError };
                        }
                        const result = await searchAndReplaceInDirectory(
                            searchRoot,
                            effectivePattern,
                            searchRegex,
                            replacement,
                            maxFiles,
                            workspaces.length > 1 ? targetWorkspace.name : null,
                            excludePattern,
                            searchConfig,
                            context?.toolId,
                            context?.abortSignal,
                            context?.conversationId,
                            context?.checkpointReady as Promise<unknown> | undefined,
                            context?.lockHolder as LockHolder | undefined
                        );
                        allMatches = result.matches;
                        allReplacements = result.replacements;
                        allSkippedFiles = result.skippedFiles;
                        totalReplacements = result.totalReplacements;
                        anyCancelled = result.cancelled;
                        anyTruncated = result.truncated;
                    } else if (searchPath === '.' && workspaces.length > 1) {
                        // 搜索所有工作区（会话绑定工作区时仅搜索该工作区）
                        let remainingFiles = maxFiles;
                        for (const ws of searchWorkspaces) {
                            if (remainingFiles <= 0) break;
                            
                            const result = await searchAndReplaceInDirectory(
                                ws.uri,
                                filePattern,
                                searchRegex,
                                replacement,
                                remainingFiles,
                                ws.name,
                                excludePattern,
                                searchConfig,
                                context?.toolId,
                                context?.abortSignal,
                                context?.conversationId,
                                context?.checkpointReady as Promise<unknown> | undefined,
                                context?.lockHolder as LockHolder | undefined
                            );
                            allMatches.push(...result.matches);
                            allReplacements.push(...result.replacements);
                            allSkippedFiles.push(...result.skippedFiles);
                            totalReplacements += result.totalReplacements;
                            anyTruncated = anyTruncated || result.truncated;
                            // 按”实际处理过的文件数”扣减（含有匹配但未产生变化的文件），
                            // 与 searchAndReplaceInDirectory 内部的 maxFiles 语义保持一致
                            remainingFiles -= result.processedFiles;

                            anyCancelled = anyCancelled || result.cancelled;
                            if (anyCancelled) {
                                break;
                            }
                        }
                    } else {
                        // 单工作区或未指定，使用默认
                        const root = targetWorkspace?.uri || workspaces[0].uri;
                        const { searchRoot, effectivePattern } = await getSearchRootAndPattern(
                            root,
                            relativePath,
                            filePattern
                        );
                        const accessError = getSearchRootAccessError(searchRoot, args, context);
                        if (accessError) {
                            return { success: false, error: accessError };
                        }
                        const result = await searchAndReplaceInDirectory(
                            searchRoot,
                            effectivePattern,
                            searchRegex,
                            replacement,
                            maxFiles,
                            workspaces.length > 1 ? (targetWorkspace?.name || workspaces[0].name) : null,
                            excludePattern,
                            searchConfig,
                            context?.toolId,
                            context?.abortSignal,
                            context?.conversationId,
                            context?.checkpointReady as Promise<unknown> | undefined,
                            context?.lockHolder as LockHolder | undefined
                        );
                        allMatches = result.matches;
                        allReplacements = result.replacements;
                        allSkippedFiles = result.skippedFiles;
                        totalReplacements = result.totalReplacements;
                        anyCancelled = result.cancelled;
                        anyTruncated = result.truncated;
                    }

                    // 0 命中诊断：帮模型区分“真没匹配”和“大小写语义差异导致的漏匹配”
                    let zeroMatchHint: string | undefined;
                    if (!anyCancelled && allMatches.length === 0 && allReplacements.length === 0) {
                        zeroMatchHint = caseSensitive
                            ? 'No matches found. Note: replace mode matches case-sensitively by default while search mode is case-insensitive by default. If you located the target via a search-mode query, retry with caseSensitive=false or adjust the query casing.'
                            : 'No matches found even with case-insensitive matching. Verify the query text, target path and file pattern.';
                    }

                    // 多工作区聚合时各目录独立封顶，这里再对总量兜底，保证回传的 matches 有硬上限
                    if (allMatches.length > MAX_REPLACE_MATCHES) {
                        allMatches = allMatches.slice(0, MAX_REPLACE_MATCHES);
                        anyTruncated = true;
                    }

                    return {
                        success: !anyCancelled,
                        cancelled: anyCancelled,
                        data: {
                            isReplaceMode: true,
                            matches: allMatches.map(m => ({
                                file: m.file,
                                workspace: m.workspace,
                                line: m.line,
                                column: m.column,
                                match: m.match
                                // 替换模式下不返回 context，减小体积，前端已有 diff 视图
                            })),
                            results: allReplacements,
                            filesModified: allReplacements.length,
                            totalReplacements,
                            truncated: anyTruncated,
                            caseSensitive,
                            skippedFiles: allSkippedFiles.length > 0 ? allSkippedFiles : undefined,
                            zeroMatchHint,
                            multiRoot: workspaces.length > 1,
                            pathWarning: allMatches.length === 0 && allReplacements.length === 0 ? pathWarning : undefined
                        },
                        error: anyCancelled ? 'Search/replace was cancelled by user' : undefined
                    };
                } else {
                    // 仅搜索模式
                    const configuredMaxTotal = searchConfig.maxTotalResultChars;
                    const maxTotalChars = (typeof configuredMaxTotal === 'number' && Number.isFinite(configuredMaxTotal))
                        ? Math.floor(configuredMaxTotal)
                        : 200000;
                    const budget: SearchBudget | undefined = maxTotalChars > 0
                        ? { remainingChars: maxTotalChars, truncated: false }
                        : undefined;
                    
                    const runSearchPass = async (regex: RegExp): Promise<SearchPassResult> => {
                        const results: SearchMatch[] = [];

                        if (isExplicit && targetWorkspace) {
                            // 显式指定了工作区，只搜索该工作区
                            const { searchRoot, effectivePattern } = await getSearchRootAndPattern(
                                targetWorkspace.uri,
                                relativePath,
                                filePattern
                            );
                            const accessError = getSearchRootAccessError(searchRoot, args, context);
                            if (accessError) {
                                throw new OutsideWorkspaceAccessError(accessError);
                            }
                            results.push(...await searchInDirectory(
                                searchRoot,
                                effectivePattern,
                                regex,
                                maxResults,
                                workspaces.length > 1 ? targetWorkspace.name : null,
                                excludePattern,
                                searchConfig,
                                budget
                            ));
                        } else if (searchPath === '.' && workspaces.length > 1) {
                            // 搜索所有工作区（会话绑定工作区时仅搜索该工作区）
                            for (const ws of searchWorkspaces) {
                                if (results.length >= maxResults) break;
                                if (budget && budget.remainingChars <= 0) break;

                                const remaining = maxResults - results.length;
                                const wsResults = await searchInDirectory(
                                    ws.uri,
                                    filePattern,
                                    regex,
                                    remaining,
                                    ws.name,
                                    excludePattern,
                                    searchConfig,
                                    budget
                                );
                                results.push(...wsResults);
                            }
                        } else {
                            // 单工作区或未指定，使用默认
                            const root = targetWorkspace?.uri || workspaces[0].uri;
                            const { searchRoot, effectivePattern } = await getSearchRootAndPattern(
                                root,
                                relativePath,
                                filePattern
                            );
                            const accessError = getSearchRootAccessError(searchRoot, args, context);
                            if (accessError) {
                                throw new OutsideWorkspaceAccessError(accessError);
                            }
                            results.push(...await searchInDirectory(
                                searchRoot,
                                effectivePattern,
                                regex,
                                maxResults,
                                workspaces.length > 1 ? (targetWorkspace?.name || workspaces[0].name) : null,
                                excludePattern,
                                searchConfig,
                                budget
                            ));
                        }

                        return {
                            results,
                            budgetTruncated: !!budget?.truncated
                        };
                    };

                    let searchPass = await runSearchPass(searchRegex);
                    let allResults = searchPass.results;
                    let fallbackInfo: SearchQueryFallbackInfo | undefined;

                    const fallbackKeywords = !isRegex ? splitWhitespaceFallbackKeywords(query) : [];
                    if (allResults.length === 0 && !searchPass.budgetTruncated && fallbackKeywords.length > 0) {
                        const fallbackRegex = createFallbackKeywordRegex(fallbackKeywords, flags);
                        searchPass = await runSearchPass(fallbackRegex);
                        allResults = searchPass.results;
                        fallbackInfo = {
                            applied: true,
                            originalQuery: query,
                            keywords: fallbackKeywords,
                            reason: 'whitespace_keyword_or'
                        };
                    }

                    if (allResults.length === 0 && !searchPass.budgetTruncated && !isRegex) {
                        const regexIntent = detectSuspectedRegexIntent(query);
                        if (regexIntent.suspected) {
                            fallbackInfo = {
                                applied: false,
                                originalQuery: query,
                                keywords: [],
                                reason: 'suspected_regex',
                                signals: regexIntent.signals,
                                suggestion: createSuspectedRegexSuggestion(regexIntent.signals)
                            };
                        }
                    }

                    return {
                        success: true,
                        data: {
                            results: allResults,
                            count: allResults.length,
                            truncated: allResults.length >= maxResults || searchPass.budgetTruncated,
                            multiRoot: workspaces.length > 1,
                            queryFallback: fallbackInfo,
                            pathWarning: allResults.length === 0 ? pathWarning : undefined
                        }
                    };
                }
            } catch (error) {
                if (error instanceof OutsideWorkspaceAccessError) {
                    // 工作区外访问被策略拒绝/需要确认：直接透传可读错误（与 read_file 一致）
                    return { success: false, error: error.message };
                }
                return {
                    success: false,
                    error: `Search failed: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
    };
}

/**
 * 注册搜索文件内容工具
 */
export function registerSearchInFiles(): Tool {
    return createSearchInFilesTool();
}