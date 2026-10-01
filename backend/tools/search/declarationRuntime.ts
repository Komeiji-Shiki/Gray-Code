import type { Tool, ToolResult } from '../types';
import { parseArgs } from '../types';
import { validateRegexPattern } from '../../core/services/regexGuard';
import type { LockHolder } from '../../core/fileWriteLockManager';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import {escapeRegExp,detectSuspectedRegexIntent,createSuspectedRegexSuggestion} from '../shared/textUtils';
import type {SearchFileHost,FileLocation} from './fileHost';
import {createSearchPass,type SearchMatch,type SearchBudget,type SearchPageState,type SearchPassResult,type SearchQueryFallbackInfo,type SearchPathWarningInfo} from './searchPassRuntime';
import {createReplacePass,type ReplaceResult,type SkippedFileInfo} from './replacePassRuntime';
import { TextSearchWorker } from './textSearchWorker';
interface SearchInFilesArgs {
    mode?: 'search' | 'replace';
    query?: string;
    path?: string;
    pattern?: string;
    isRegex?: boolean;
    keywordFallback?: boolean;
    includeIgnored?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
    offset?: number;
    context?: number;
    replace?: string;
    maxFiles?: number;
}

/** 单次搜索可请求的上下文行数上限，与 find_references 的 context 参数一致。 */
const MAX_CONTEXT_LINES = 10;
export function createSearchDeclaration(host: SearchFileHost) {
const {searchInDirectory,getSearchRootAndPattern,getSearchInFilesConfig,getExcludePattern,splitWhitespaceFallbackKeywords,createFallbackKeywordRegex}=createSearchPass(host);
const {searchAndReplaceInDirectory,MAX_REPLACE_MATCHES}=createReplacePass(host);
function getSearchRootAccessError(
    searchRoot: FileLocation,
    args: Record<string, unknown>,
    context?: import('../types').ToolContext
): string | null {
    const info = host.resolveFileToolPathWithInfo(searchRoot.fsPath);
    if (!info.isOutsideWorkspace) {
        return null;
    }
    return host.checkAccess(
        'search_in_files',
        { path: searchRoot.fsPath, mode: args.mode },
        context
    );
}

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

function createSearchInFilesTool(): Tool {
    // 获取工作区信息用于描述
    const workspaces = host.getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
    // 路径写法、多根工作区格式和可用名称只写在 path 参数里，主说明不重复。
    let pathDescription = isZh
        ? '一个搜索路径，相对于工作区根目录。目录写成 "dir/"（带尾部斜杠），单个文件写成 "dir/file.ext"，默认 "." 表示整个工作区。要搜索多个路径时，请分别调用。'
        : 'One search path relative to the workspace root. Write directories as "dir/" (with a trailing slash) and single files as "dir/file.ext"; the default "." searches the whole workspace. To search several paths, make separate calls.';
    if (isMultiRoot) {
        pathDescription = isZh
            ? `一个搜索路径，格式为 "workspace_name/path"。目录写成 "workspace_name/dir/"（带尾部斜杠），单个文件写成 "workspace_name/file.ext"，"." 表示搜索所有工作区。要搜索多个路径时，请分别调用。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `One search path in the "workspace_name/path" format. Write directories as "workspace_name/dir/" (with a trailing slash) and single files as "workspace_name/file.ext"; "." searches all workspaces. To search several paths, make separate calls. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
    }
    
    return {
        declaration: {
            name: 'search_in_files',
            strict: true,  // API 端强制 schema 校验
            description: (isMultiRoot
                ? isZh
                    ? '在工作区文件中搜索内容，或搜索后替换，支持正则表达式。当前是多根工作区，path 的写法见参数说明。'
                    : 'Search workspace files for content, or search and replace it, with optional regular expressions. This is a multi-root workspace; see the path parameter for how to write paths.'
                : isZh
                    ? '在工作区文件中搜索内容，或搜索后替换，支持正则表达式。'
                    : 'Search workspace files for content, or search and replace it, with optional regular expressions.') + (isZh
                        ? '\n\n搜索会检查全部候选文件，不会因为文件多而提前停止。结果、maxResults 和 offset 都按命中行计数，同一行的多处命中算一条。结果按文件分组："行号:列号: 内容" 是命中行，多处命中的列号用逗号分隔；"行号- 内容" 是上下文；"--" 分隔不相邻的片段。返回 nextOffset 时，把它作为 offset 传入即可读取下一页，其他参数保持不变；文件变化后从 offset=0 重新查询。truncationReasons 说明结果是因为命中数还是输出长度受限；输出长度不够时，请按 continuationHint 缩小范围。'
                        : '\n\nThe search checks every candidate file and does not stop early because there are many files. Results, maxResults and offset all count matching lines, and several matches on one line count as one. Results are grouped by file: "line:col: text" is a matching line, with comma-separated columns when a line matches more than once; "line- text" is context; "--" separates non-adjacent snippets. When nextOffset is returned, pass it as offset to read the next page, keeping the other parameters unchanged; restart from offset 0 if files change. truncationReasons tells you whether the match count or the output size was the limit; when output size is the limit, narrow the search as continuationHint suggests.'),
            category: 'search',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['search', 'replace'],
                        description: isZh
                            ? '操作模式："search" 只查找，"replace" 查找并替换。'
                            : 'Operation mode: "search" only finds matches; "replace" finds and replaces them.',
                        default: 'search'
                    },
                    query: {
                        type: 'string',
                        description: isZh
                            ? '要搜索的文本或正则表达式。默认按完整字面短语匹配，不会拆词。查询里用到正则语法（如 "|"、".*"、".+"、"\\."、"\\d"、"[]"、"()"、"^" 或 "$"）时，请设 isRegex=true。'
                            : 'Text or regular expression to search for. By default the whole query is matched as a literal phrase and is not split into words. If the query uses regex syntax such as "|", ".*", ".+", "\\.", "\\d", "[]", "()", "^" or "$", set isRegex=true.'
                    },
                    path: {
                        type: 'string',
                        description: pathDescription,
                        default: '.'
                    },
                    pattern: {
                        type: 'string',
                        description: isZh
                            ? '文件名要匹配的 glob，例如 "*.ts" 或 "**/*.js"。'
                            : 'Glob that file names must match, for example "*.ts" or "**/*.js".',
                        default: '**/*'
                    },
                    isRegex: {
                        type: 'boolean',
                        description: isZh
                            ? '是否把 query 当作正则表达式，默认 false。为 false 时正则符号按字面搜索；如果没有结果，可能会返回 suspected_regex 提示，但不会自动改变查询含义。'
                            : 'Whether query is a regular expression; default false. When false, regex symbols are searched literally, and a search with no results may return a suspected_regex hint, but the query meaning is never changed automatically.',
                        default: false
                    },
                    keywordFallback: {
                        type: 'boolean', default: false,
                        description: isZh
                            ? '设为 true 时，如果完整短语没有命中，会按空白拆成关键词并用 OR 重试。默认 false，保持查询原意。只在 search 模式且 isRegex=false 时生效。'
                            : 'When true and the full phrase has no matches, the query is split on whitespace and retried as keywords joined with OR. Defaults to false, which keeps the exact query. Only applies in search mode with isRegex=false.'
                    },
                    includeIgnored: {
                        type: 'boolean', default: false,
                        description: isZh
                            ? `默认遵守搜索排除设置${host.gitIgnoreSupported ? '和项目 .gitignore' : ''}。设为 true 会连被忽略的文件一起搜索${host.gitIgnoreSupported ? '，但 .git 元数据和符号链接仍会跳过' : ''}。`
                            : `By default, search exclusions${host.gitIgnoreSupported ? ' and project .gitignore files' : ''} are respected. true also searches ignored files${host.gitIgnoreSupported ? ', though .git metadata and symlinks are still skipped' : ''}.`
                    },
                    caseSensitive: {
                        type: 'boolean',
                        description: isZh
                            ? '是否区分大小写。search 模式默认不区分，便于定位；replace 模式默认区分，避免误替换。可以显式传值覆盖，例如在 replace 模式下传 false，替换不区分大小写搜到的内容。'
                            : 'Whether matching is case-sensitive. Search mode defaults to false so matches are easier to find; replace mode defaults to true to avoid unintended replacements. Pass a value to override, for example false in replace mode to replace matches found case-insensitively.'
                    },
                    maxResults: {
                        type: 'number',
                        description: isZh ? '仅 search 模式：每页最多返回的命中行数。' : 'Search mode only: maximum matching lines per page.',
                        default: 100
                    },
                    context: {
                        type: 'integer', minimum: 0, maximum: MAX_CONTEXT_LINES,
                        description: isZh
                            ? `仅 search 模式：每个命中前后显示的上下文行数，范围 0-${MAX_CONTEXT_LINES}。省略时使用搜索设置，0 表示只返回命中行。`
                            : `Search mode only: context lines before and after each match, 0-${MAX_CONTEXT_LINES}. When omitted, the search settings apply; 0 returns only the matching lines.`
                    },
                    offset: {
                        type: 'integer', minimum: 0, default: 0,
                        description: isZh
                            ? '仅 search 模式：要跳过的命中行数，用于分页。'
                            : 'Search mode only: number of matching lines to skip, used for paging.'
                    },
                    replace: {
                        type: 'string',
                        description: isZh
                            ? '仅 replace 模式：替换后的字符串，必须显式提供，省略时会报错且不修改文件。传空字符串表示删除匹配内容。isRegex=true 时可以用 $1、$2 等捕获组。'
                            : 'Replace mode only: the replacement string. It must be given explicitly; if omitted, the call fails without changing any file. An empty string deletes the matches. With isRegex=true you can use capture groups such as $1 and $2.'
                    },
                    maxFiles: {
                        type: 'number',
                        description: isZh ? '仅 replace 模式：最多处理的文件数。' : 'Replace mode only: maximum number of files to process.',
                        default: 50
                    }
                },
                required: ['query']
            }
        },
        handler: async (args, context?: import('../types').ToolContext): Promise<ToolResult> => {
            const typed = parseArgs<SearchInFilesArgs>(args);
            const query = typed.query as string;
            const searchPath = typed.path || '.';
            const filePattern = typed.pattern || '**/*';
            const isRegex = typed.isRegex || false;
            // 精确查询不应因零命中而自动改变含义；宽搜必须显式选择。
            const keywordFallback = typed.keywordFallback === true;
            if (typed.keywordFallback !== undefined && typeof typed.keywordFallback !== 'boolean') {
                return { success: false, error: 'keywordFallback must be a boolean' };
            }
            if (typed.includeIgnored !== undefined && typeof typed.includeIgnored !== 'boolean') {
                return { success: false, error: 'includeIgnored must be a boolean' };
            }
            const includeIgnored = typed.includeIgnored === true;
            
            // 严格按照 mode 字段决定模式，忽略其他不相关的参数
            const mode = typed.mode || 'search';
            const isReplaceMode = mode === 'replace';
            const offset = typed.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) {
                return { success: false, error: 'offset must be a non-negative safe integer' };
            }
            if (isReplaceMode && offset !== 0) {
                return { success: false, error: 'offset is only supported in search mode; replacement is not paginated' };
            }
            if (typed.context !== undefined && (!Number.isInteger(typed.context) || typed.context < 0 || typed.context > MAX_CONTEXT_LINES)) {
                return { success: false, error: `context must be an integer between 0 and ${MAX_CONTEXT_LINES}` };
            }

            // replace 模式下 replace 参数必须显式提供：漏传时替换串为空会静默删除所有匹配内容
            if (isReplaceMode && typeof typed.replace !== 'string') {
                return {
                    success: false,
                    error: 'replace parameter is required when mode is "replace"'
                };
            }

            // 大小写语义：search 默认不区分（方便定位），replace 默认区分（保守替换）。
            // 支持显式覆盖，并在 0 命中时通过诊断信息提醒模型两种模式的默认差异，
            // 避免“search 搜得到、replace 替不了”的困惑。
            const caseSensitive = typeof typed.caseSensitive === 'boolean'
                ? typed.caseSensitive
                : isReplaceMode;
            
            // 搜索模式参数（0/负值/非数字语义混乱：统一回退默认 100 并取整，参照 find_files）
            const maxResults = typeof typed.maxResults === 'number' && Number.isFinite(typed.maxResults) && typed.maxResults > 0
                ? Math.max(1, Math.floor(typed.maxResults)) : 100;
            
            // 替换模式参数（仅在替换模式下使用）。
            // isRegex=false 时 query 按字面量匹配，替换串也必须按字面量写入：
            // 转义 $ 序列，防止 $&/$1/$$ 被 String.replace 解释为特殊替换模式
            //（工具描述承诺捕获组仅在 isRegex=true 时生效）。
            const rawReplacement = isReplaceMode ? (typed.replace ?? '') : '';
            const replacement = isReplaceMode && !isRegex
                ? rawReplacement.replace(/\$/g, '$$$$')
                : rawReplacement;
            const maxFiles = isReplaceMode && typeof typed.maxFiles === 'number' && typed.maxFiles > 0
                ? Math.floor(typed.maxFiles)
                : 50;

            if (!query) {
                return { success: false, error: 'query is required' };
            }

            const workspaces = host.getAllWorkspaces();
            if (workspaces.length === 0) {
                return { success: false, error: 'No workspace folder open' };
            }

            let computation: TextSearchWorker | undefined;
            try {
                // 创建搜索正则表达式（均为全局匹配）
                // search 模式额外启用多行标志 m；大小写由 caseSensitive 控制
                const flags = (isReplaceMode ? 'g' : 'gm') + (caseSensitive ? '' : 'i');
                // 启发式先拒绝明显危险的模式；实际正则仍交给线程执行，取消不依赖主线程完成匹配。
                const regexSource = isRegex ? query : escapeRegExp(query);
                const guardedRegex = validateRegexPattern(regexSource, flags);
                if (!guardedRegex.ok) {
                    return {
                        success: false,
                        error: guardedRegex.error
                    };
                }
                const searchRegex = guardedRegex.regex;
                if (isRegex) computation = new TextSearchWorker({ signal: context?.abortSignal });
                
                // 获取配置与排除模式；显式 context 只覆盖本次搜索的上下文行数，替换模式不返回上下文。
                const configured = getSearchInFilesConfig();
                const searchConfig = !isReplaceMode && typed.context !== undefined
                    ? { ...configured, contextLinesBefore: typed.context, contextLinesAfter: typed.context }
                    : configured;
                const excludePattern = includeIgnored ? '**/.git/**' : getExcludePattern(searchConfig);
                
                // 解析路径，确定搜索范围
                const parsedPath = host.parseWorkspacePath(searchPath);
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
                            context?.lockHolder as LockHolder | undefined,
                            computation,
                            { includeIgnored }
                        );
                        allMatches = result.matches;
                        allReplacements = result.replacements;
                        allSkippedFiles = result.skippedFiles;
                        totalReplacements = result.totalReplacements;
                        anyCancelled = result.cancelled;
                        anyTruncated = result.truncated;
                    } else if (searchPath === '.' && workspaces.length > 1) {
                        // 搜索所有工作区
                        let remainingFiles = maxFiles;
                        for (const ws of workspaces) {
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
                                context?.lockHolder as LockHolder | undefined,
                                computation,
                                { includeIgnored }
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
                            context?.lockHolder as LockHolder | undefined,
                            computation,
                            { includeIgnored }
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

                    const acceptedReplacements = allReplacements.filter(item => item.status === 'accepted');
                    const filesRejected = allReplacements.filter(item => item.status === 'rejected').length;
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
                            filesModified: acceptedReplacements.length,
                            totalReplacements: acceptedReplacements.reduce((total, item) => total + item.replacements, 0),
                            proposedReplacements: totalReplacements,
                            filesRejected,
                            partial: acceptedReplacements.length > 0 && filesRejected > 0,
                            truncated: anyTruncated,
                            caseSensitive,
                            effectiveExclude: excludePattern,
                            respectsGitIgnore: !!host.gitIgnoreSupported && !includeIgnored,
                            includeIgnored,
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
                    let budget: SearchBudget | undefined;
                    const runSearchPass = async (regex: RegExp): Promise<SearchPassResult> => {
                        budget = maxTotalChars > 0 ? { remainingChars: maxTotalChars, truncated: false } : undefined;
                        const page: SearchPageState = { remaining: offset, matchesSeen: 0 };
                        const results: SearchMatch[] = [];
                        const skippedFiles: SkippedFileInfo[] = [];
                        let statPathWarning: SearchPathWarningInfo | undefined;
                        // maxResults+1 探测语义（参照 find_files）：多取 1 条用于精确判定截断，
                        // 恰好等于 maxResults 条时不误报 truncated；超出部分在返回前裁剪。
                        const probeLimit = maxResults + 1;

                        if (isExplicit && targetWorkspace) {
                            // 显式指定了工作区，只搜索该工作区
                            const { searchRoot, effectivePattern, pathWarning } = await getSearchRootAndPattern(
                                targetWorkspace.uri,
                                relativePath,
                                filePattern
                            );
                            if (pathWarning) statPathWarning = pathWarning;
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
                                budget,
                                page,
                                { computation, signal: context?.abortSignal, includeIgnored }
                            );
                            results.push(...pass.matches);
                            skippedFiles.push(...pass.skippedFiles);
                        } else if (searchPath === '.' && workspaces.length > 1) {
                            // 搜索所有工作区
                            for (const ws of workspaces) {
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
                                    budget,
                                    page,
                                    { computation, signal: context?.abortSignal, includeIgnored }
                                );
                                results.push(...wsPass.matches);
                                skippedFiles.push(...wsPass.skippedFiles);
                            }
                        } else {
                            // 单工作区或未指定，使用默认
                            const root = targetWorkspace?.uri || workspaces[0].uri;
                            const { searchRoot, effectivePattern, pathWarning } = await getSearchRootAndPattern(
                                root,
                                relativePath,
                                filePattern
                            );
                            if (pathWarning) statPathWarning = pathWarning;
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
                                budget,
                                page,
                                { computation, signal: context?.abortSignal, includeIgnored }
                            );
                            results.push(...pass.matches);
                            skippedFiles.push(...pass.skippedFiles);
                        }

                        // 探测多取 1 条：只有真的超出 maxResults 才算截断；恰好等于时裁剪后不报 truncated
                        const matchesTruncated = results.length > maxResults;
                        if (matchesTruncated) {
                            results.length = maxResults;
                        }

                        return {
                            results,
                            matchesSeen: page.matchesSeen,
                            matchesTruncated,
                            budgetTruncated: !!budget?.truncated,
                            skippedFiles,
                            pathWarning: statPathWarning
                        };
                    };

                    let searchPass = await runSearchPass(searchRegex);
                    let allResults = searchPass.results;
                    let fallbackInfo: SearchQueryFallbackInfo | undefined;

                    const fallbackKeywords = !isRegex && keywordFallback ? splitWhitespaceFallbackKeywords(query) : [];
                    if (searchPass.matchesSeen === 0 && !searchPass.budgetTruncated && fallbackKeywords.length > 0) {
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

                    if (searchPass.matchesSeen === 0 && !searchPass.budgetTruncated && !isRegex) {
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

                    const truncationReasons = [
                        ...(searchPass.matchesTruncated ? ['maxResults'] : []),
                        ...(searchPass.budgetTruncated ? ['outputBudget'] : [])
                    ];
                    // 预算可能跳过中间的长匹配；不能用简单 offset 冒充无遗漏续查。
                    const nextOffset = searchPass.matchesTruncated && !searchPass.budgetTruncated
                        ? offset + allResults.length : undefined;
                    const continuationHint = [
                        ...(nextOffset !== undefined ? [`Continue with offset=${nextOffset} and unchanged search parameters; restart at offset=0 if files changed.`] : []),
                        ...(searchPass.budgetTruncated ? ['Output budget omitted matches: narrow query/path/pattern or pass a smaller context, then restart at offset=0.'] : [])
                    ].join(' ');
                    return {
                        success: true,
                        data: {
                            results: allResults,
                            count: allResults.length,
                            offset,
                            nextOffset,
                            truncationReasons: truncationReasons.length ? truncationReasons : undefined,
                            continuationHint: continuationHint || undefined,
                            // 修改原因：allResults.length >= maxResults 在「恰好 maxResults 条」时误报 truncated；
                            // 修改方式：改用 runSearchPass 的 maxResults+1 探测结果（matchesTruncated），
                            //          与 find_files 的探测语义一致。
                            truncated: searchPass.matchesTruncated || searchPass.budgetTruncated,
                            multiRoot: workspaces.length > 1,
                            queryFallback: fallbackInfo,
                            searchHint: !isRegex && !keywordFallback && searchPass.matchesSeen === 0 && !searchPass.budgetTruncated
                                && splitWhitespaceFallbackKeywords(query).length > 0
                                ? 'No exact phrase matches. To explicitly broaden this query, retry with keywordFallback=true.' : undefined,
                            effectiveExclude: excludePattern,
                            respectsGitIgnore: !!host.gitIgnoreSupported && !includeIgnored,
                            includeIgnored,
                            // 处理失败/被护栏跳过的文件及原因：与 replace 模式的 skippedFiles 同构，
                            // 让模型能区分「真没有匹配」与「N 个文件因权限/IO/大小被跳过」
                            skippedFiles: searchPass.skippedFiles.length > 0 ? searchPass.skippedFiles : undefined,
                            // 0 命中时优先展示 possible_multiple_paths 诊断，其次展示 stat 失败降级说明
                            pathWarning: allResults.length === 0
                                ? (pathWarning ?? searchPass.pathWarning)
                                : undefined
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
            } finally {
                await computation?.close();
            }
        }
    };
}

function registerSearchInFiles(): Tool {
    return createSearchInFilesTool();
}
return {createSearchInFilesTool,registerSearchInFiles};
}
