/**
 * search_in_files 工具声明（模块化拆分）
 *
 * 工具参数 schema、动态 description（工厂每次调用时基于工作区快照生成，
 * ToolRegistry.refreshTool 依赖工厂可重入）、mode=replace 门控与错误文案。
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import {
    getAllWorkspaces,
    getWorkspaceByUri,
    parseWorkspacePath,
    escapeRegExp,
    detectSuspectedRegexIntent,
    createSuspectedRegexSuggestion,
    resolveFileToolPathWithInfo
} from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { validateRegexPattern } from '../../core/services/regexGuard';
import type { LockHolder } from '../../core/fileWriteLockManager';
import {
    searchInDirectory,
    getSearchRootAndPattern,
    getSearchInFilesConfig,
    getExcludePattern,
    splitWhitespaceFallbackKeywords,
    createFallbackKeywordRegex
} from './searchPass';
import type {
    SearchMatch,
    SearchBudget,
    SearchPassResult,
    SearchQueryFallbackInfo,
    SearchPathWarningInfo
} from './searchPass';
import { searchAndReplaceInDirectory, MAX_REPLACE_MATCHES } from './replacePass';
import type { ReplaceResult, SkippedFileInfo } from './replacePass';

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
            
            // 搜索模式参数（0/负值/非数字语义混乱：统一回退默认 100 并取整，参照 find_files）
            const maxResults = typeof args.maxResults === 'number' && args.maxResults > 0 ? Math.floor(args.maxResults) : 100;
            
            // 替换模式参数（仅在替换模式下使用）。
            // isRegex=false 时 query 按字面量匹配，替换串也必须按字面量写入：
            // 转义 $ 序列，防止 $&/$1/$$ 被 String.replace 解释为特殊替换模式
            //（工具描述承诺捕获组仅在 isRegex=true 时生效）。
            const rawReplacement = isReplaceMode ? ((args.replace as string) ?? '') : '';
            const replacement = isReplaceMode && !isRegex
                ? rawReplacement.replace(/\$/g, '$$$$')
                : rawReplacement;
            const maxFiles = isReplaceMode && typeof args.maxFiles === 'number' && args.maxFiles > 0
                ? Math.floor(args.maxFiles)
                : 50;

            if (!query) {
                return { success: false, error: 'query is required' };
            }

            const workspaces = getAllWorkspaces();
            // 无打开工作区但对话绑定工作区仍存在（虚拟解析）时允许继续
            if (workspaces.length === 0 && !getWorkspaceByUri(context?.activeWorkspaceUri as string)) {
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
                        // maxResults+1 探测语义（参照 find_files）：多取 1 条用于精确判定截断，
                        // 恰好等于 maxResults 条时不误报 truncated；超出部分在返回前裁剪。
                        const probeLimit = maxResults + 1;

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
                            const pass = await searchInDirectory(
                                searchRoot,
                                effectivePattern,
                                regex,
                                probeLimit,
                                workspaces.length > 1 ? targetWorkspace.name : null,
                                excludePattern,
                                searchConfig,
                                budget
                            );
                            results.push(...pass);
                        } else if (searchPath === '.' && workspaces.length > 1) {
                            // 搜索所有工作区（会话绑定工作区时仅搜索该工作区）
                            for (const ws of searchWorkspaces) {
                                if (results.length >= probeLimit) break;
                                if (budget && budget.remainingChars <= 0) break;

                                const remaining = probeLimit - results.length;
                                const wsPass = await searchInDirectory(
                                    ws.uri,
                                    filePattern,
                                    regex,
                                    remaining,
                                    ws.name,
                                    excludePattern,
                                    searchConfig,
                                    budget
                                );
                                results.push(...wsPass);
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
                            const pass = await searchInDirectory(
                                searchRoot,
                                effectivePattern,
                                regex,
                                probeLimit,
                                workspaces.length > 1 ? (targetWorkspace?.name || workspaces[0].name) : null,
                                excludePattern,
                                searchConfig,
                                budget
                            );
                            results.push(...pass);
                        }

                        // 探测多取 1 条：只有真的超出 maxResults 才算截断；恰好等于时裁剪后不报 truncated
                        const matchesTruncated = results.length > maxResults;
                        if (matchesTruncated) {
                            results.length = maxResults;
                        }

                        return {
                            results,
                            matchesTruncated,
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
                            // 修改原因：allResults.length >= maxResults 在「恰好 maxResults 条」时误报 truncated；
                            // 修改方式：改用 runSearchPass 的 maxResults+1 探测结果（matchesTruncated），
                            //          与 find_files 的探测语义一致。
                            truncated: searchPass.matchesTruncated || searchPass.budgetTruncated,
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
