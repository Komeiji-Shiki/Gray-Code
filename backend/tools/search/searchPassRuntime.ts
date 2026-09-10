import * as path from 'path';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import { buildExcludePattern, DEFAULT_EXCLUDE_PATTERN } from '../shared/globUtils';
import { normalizeLineEndingsToLF, escapeRegExp } from '../shared/textUtils';
import { createTextReader, detectTextFromHeader, decodeTextBytes, type TextDetectionResult } from './textEncodingRuntime';
import type { SearchFileHost, FileLocation } from './fileHost';

export interface SearchMatch {
    file: string;
    workspace?: string;
    line: number;
    column: number;
    match: string;
    context: string;
}
export interface SearchBudget {
    remainingChars: number;
    truncated: boolean;
}
export interface SearchPassResult {
    results: SearchMatch[];
    /** 结果条数达到 maxResults 上限（maxResults+1 探测判定，恰好等于 maxResults 时不置位） */
    matchesTruncated: boolean;
    budgetTruncated: boolean;
    /** findFiles 达到文件数上限（结果可能不完整） */
    filesTruncated: boolean;
    /** 处理失败/被大小护栏跳过的文件及原因（与 replacePass 的 SkippedFileInfo 同构） */
    skippedFiles: SkippedFileInfo[];
    /** getSearchRootAndPattern 的 stat 失败降级说明（路径不存在/不可访问时按目录处理） */
    pathWarning?: SearchPathWarningInfo;
}
export interface SkippedFileInfo {
    file: string;
    reason: string;
}
export interface SearchQueryFallbackInfo {
    applied: boolean;
    originalQuery: string;
    keywords: string[];
    reason?: 'whitespace_keyword_or' | 'suspected_regex';
    suggestion?: string;
    signals?: string[];
}
export interface SearchPathWarningInfo {
    type: 'possible_multiple_paths' | 'stat_failed_treated_as_directory';
    path: string;
    candidates: string[];
    message: string;
}
export function createSearchPass(host: SearchFileHost) {
const {tryGetFileSizeBytes,readHeaderBytes}=createTextReader(host);

function getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
    return host.searchConfig();
}

function getExcludePattern(config: Readonly<SearchInFilesToolConfig>): string {
    return buildExcludePattern(config.excludePatterns, DEFAULT_EXCLUDE_PATTERN);
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

function clampNonNegativeNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return value < 0 ? 0 : value;
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

async function searchInDirectory(
    searchRoot: FileLocation,
    filePattern: string,
    searchRegexInput: RegExp,
    maxResults: number,
    workspaceName: string | null,
    excludePattern: string,
    config: Readonly<SearchInFilesToolConfig>,
    budget?: SearchBudget
): Promise<{ matches: SearchMatch[]; filesTruncated: boolean; skippedFiles: SkippedFileInfo[] }> {
    // 本地克隆：g 标志正则携带可变 lastIndex 状态，共享实例跨函数/跨循环传递
    // 全靠每处使用前手动重置，极其脆弱；克隆后状态完全局限在本函数内。
    const searchRegex = new RegExp(searchRegexInput.source, searchRegexInput.flags);
    const results: SearchMatch[] = [];
    const skippedFiles: SkippedFileInfo[] = [];
    
    
    const findLimit = Math.max(1, Math.floor(clampNonNegativeNumber(config.maxFindFiles, 1000)));
    const foundFiles = await host.findFiles(searchRoot, filePattern, excludePattern, findLimit + 1);
    const filesTruncated = foundFiles.length > findLimit;
    const files = filesTruncated ? foundFiles.slice(0, findLimit) : foundFiles;

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
                    skippedFiles.push({
                        file: host.toRelativePath(fileUri, workspaceName !== null),
                        reason: `File exceeds the search size limit (${size} > ${maxFileSizeBytes} bytes)`
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
                    // header 检测失败时退化为旧行为（仍有大小/输出护栏）
                    detection = { isText: true, encoding: 'utf-8', bomLength: 0 };
                }
            }

            const content = await host.readFile(fileUri);
            const text = normalizeLineEndingsToLF(decodeTextBytes(content, detection));
            const lines = text.split('\n');

            // 使用支持多工作区的相对路径（每文件只计算一次）
            const relativePath = host.toRelativePath(fileUri, workspaceName !== null);
            
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
        } catch (e) {
            // 处理失败不再静默吞掉：与 replacePass 一致记录原因，
            // 让模型能区分“没匹配”和“处理失败”（EACCES/IO 等）。
            skippedFiles.push({
                file: host.toRelativePath(fileUri, workspaceName !== null),
                reason: `Failed to process: ${e instanceof Error ? e.message : String(e)}`
            });
        }
    }
    
    return { matches: results, filesTruncated, skippedFiles };
}

async function getSearchRootAndPattern(
    rootUri: FileLocation,
    relativePath: string,
    filePattern: string
): Promise<{ searchRoot: FileLocation; effectivePattern: string; pathWarning?: SearchPathWarningInfo }> {
    // 空路径或当前目录，直接用 workspace 根目录
    if (!relativePath || relativePath === '.' || relativePath === './') {
        return { searchRoot: rootUri, effectivePattern: filePattern };
    }

    const fullUri = host.joinPath(rootUri, relativePath);

    try {
        const stat = await host.stat(fullUri);
        if (stat.type === 1) {
            // 是单个文件：搜索根为所在目录，pattern 为文件名
            const fsPath = fullUri.fsPath;
            const dirPath = path.dirname(fsPath);
            const fileName = path.basename(fsPath);
            return {
                searchRoot: host.file(dirPath),
                effectivePattern: fileName

            };
        }
    } catch {
        // stat 失败（路径不存在或权限问题），按目录处理；附 pathWarning 让模型知道
        // 根路径可能写错，而不是把「无结果」静默归因于没有匹配。
        return {
            searchRoot: fullUri,
            effectivePattern: filePattern,
            pathWarning: {
                type: 'stat_failed_treated_as_directory',
                path: relativePath,
                candidates: [],
                message: `Could not stat "${relativePath}" (it may not exist or may not be accessible), so it was searched as a directory. If you meant a single file, check the path spelling.`
            }
        };
    }

    // 默认按目录处理
    return {
        searchRoot: fullUri,
        effectivePattern: filePattern
    };
}
return {getSearchInFilesConfig,getExcludePattern,splitWhitespaceFallbackKeywords,createFallbackKeywordRegex,clampNonNegativeNumber,truncateWithEllipsis,searchInDirectory,getSearchRootAndPattern};
}
