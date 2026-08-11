/**
 * search_in_files 搜索遍历与匹配（模块化拆分）
 *
 * 搜索模式（mode=search）的目录遍历、exclude 匹配、并发读取、大小护栏与匹配逻辑；
 * 同时承载搜索/替换共用的类型、配置与小工具。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { toRelativePath, normalizeLineEndingsToLF, escapeRegExp, isPathInsideOrEqualReal, mapWithConcurrency } from '../utils';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';
import type { SearchInFilesToolConfig } from '../../modules/settings/types';
import { DEFAULT_EXCLUDE_GLOB } from '../ignoreLists';
import {
    tryGetFileSizeBytes,
    readHeaderBytes,
    detectTextFromHeader,
    decodeTextBytes
} from './textEncoding';
import type { TextDetectionResult } from './textEncoding';

/**
 * 默认排除模式（统一收敛自 ../ignoreLists）
 */
const DEFAULT_EXCLUDE = DEFAULT_EXCLUDE_GLOB;

/**
 * 文件级扫描并发上限。
 *
 * 修改原因：searchInDirectory / searchAndReplaceInDirectory 对最多 1000 个文件
 * 串行做 stat/读文件头/读全文等 I/O，单次搜索耗时随文件数线性增长。
 * 修改方式：复用 utils.mapWithConcurrency 受控并发（默认 8），结果仍按原文件顺序返回。
 */
export const FILE_SCAN_CONCURRENCY = 8;

/**
 * 获取 search_in_files 工具配置（带默认值兜底）
 */
export function getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
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
export function getExcludePattern(config: Readonly<SearchInFilesToolConfig>): string {
    if (config.excludePatterns && config.excludePatterns.length > 0) {
        // 多个模式用 {} 语法组合
        if (config.excludePatterns.length === 1) {
            return config.excludePatterns[0];
        }
        return `{${config.excludePatterns.join(',')}}`;
    }
    return DEFAULT_EXCLUDE;
}

export function splitWhitespaceFallbackKeywords(query: string): string[] {
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

export function createFallbackKeywordRegex(keywords: string[], flags: string): RegExp {
    return new RegExp(keywords.map(escapeRegExp).join('|'), flags);
}

/**
 * 搜索匹配项
 */
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
    type: 'possible_multiple_paths';
    path: string;
    candidates: string[];
    message: string;
}

export function clampNonNegativeNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return value < 0 ? 0 : value;
}

export function truncateWithEllipsis(text: string, maxChars: number): string {
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
export async function searchInDirectory(
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

    // 共享匹配总数：达到 maxResults 后仍"在飞"的任务快速退出（并发下无法立即中断，
    // 但可避免继续发起新工作）；结果按原文件顺序由外部拼接，保证返回顺序不变。
    let totalResults = 0;

    // 修改原因：对最多 1000 个文件串行 stat/读头/读全文，I/O 全串行。
    // 修改方式：每个文件独立扫描（大小护栏、文本检测、逐行匹配），受控并发执行；
    // 扫描结果按文件顺序返回，再统一拼接，与旧的串行循环产出完全一致。
    const perFileResults = await mapWithConcurrency(files, FILE_SCAN_CONCURRENCY, async (fileUri) => {
        if (totalResults >= maxResults) {
            return [];
        }
        if (budget && budget.remainingChars <= 0) {
            budget.truncated = true;
            return [];
        }

        // 单文件局部结果：并发下各文件的匹配先各自收集，最后按文件顺序拼接，
        // 避免跨文件交错导致返回顺序与 findFiles 顺序不一致
        const localResults: SearchMatch[] = [];

        try {
            // 文件大小护栏（避免读入超大文件）
            if (maxFileSizeBytes > 0) {
                const size = await tryGetFileSizeBytes(fileUri);
                if (typeof size === 'number' && size > maxFileSizeBytes) {
                    return localResults;
                }
            }

            // 文件头文本检测（跳过二进制）
            let detection: TextDetectionResult = { isText: true, encoding: 'utf-8', bomLength: 0 };
            if (enableHeaderTextCheck) {
                try {
                    const header = await readHeaderBytes(fileUri, headerSampleBytes);
                    detection = detectTextFromHeader(header);
                    if (!detection.isText) {
                        return localResults;
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
                if (totalResults >= maxResults) {
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
                    if (totalResults >= maxResults) {
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
                    
                    localResults.push({
                        file: relativePath,
                        workspace: workspaceName || undefined,
                        line: i + 1,
                        column: match.index + 1,
                        match: matchText,
                        context
                    });
                    // 同步段内递增，多任务交错不产生竞态
                    totalResults++;

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
        return localResults;
    });

    // 按原文件顺序拼接（mapWithConcurrency 按输入顺序返回）；并发在飞任务可能
    // 略微超出 maxResults，这里统一封顶，与旧串行循环的截断语义一致
    for (const perFile of perFileResults) {
        results.push(...perFile);
        if (results.length >= maxResults) {
            break;
        }
    }
    if (results.length > maxResults) {
        results.length = maxResults;
    }
    
    return results;
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
export async function getSearchRootAndPattern(
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
