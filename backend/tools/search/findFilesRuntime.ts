import type { Tool, ToolContext, ToolResult } from '../types';
import { parseArgs } from '../types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildExcludePattern, DEFAULT_EXCLUDE_PATTERN } from '../shared/globUtils';
import {mapWithConcurrency} from '../shared/concurrency';
import type {SearchFileHost,FileLocation} from './fileHost';
interface FoundFileDetail {
    path: string;
    /**
     * 文本文件行数；二进制文件或读取失败时省略。
     *
     * 修改原因：find_files 经常作为 read_file 前置定位器，只有路径会诱导模型直接读取未知大小文件。
     * 修改方式：保持 files 字符串数组向后兼容，同时新增 fileDetails 存放 path + lineCount。
     * 修改目的：让模型能先按行数判断是否需要范围读取。
     */
    lineCount?: number;
}
interface FindResult {
    pattern: string;
    workspace?: string;
    success: boolean;
    files?: string[];
    fileDetails?: FoundFileDetail[];
    count?: number;
    truncated?: boolean;
    offset?: number;
    nextOffset?: number;
    continuationHint?: string;
    workspaceErrors?: { workspace: string; error: string }[];
    error?: string;
}
interface FindFilesArgs {
    patterns?: string[];
    pattern?: string;
    exclude?: string;
    includeIgnored?: boolean;
    maxResults?: number;
    offset?: number;
}
export function createFindFilesRuntime(host: SearchFileHost) {

async function findInWorkspace(
    workspace: { name: string; uri: FileLocation },
    pattern: string,
    exclude: string,
    maxResults: number,
    includeWorkspacePrefix: boolean,
    page: { remaining: number },
    includeIgnored: boolean,
    signal?: AbortSignal
): Promise<FindResult> {
    try {
        signal?.throwIfAborted();
        // offset 先按宿主发现顺序跳过，再保持旧的页内排序；不能先全局排序，
        // 否则会改变首批结果与已有遍历预算。只统计本页行数，不重读已跳过文件。
        // 多取 1 个仅用于精确判定截断，跨工作区共享剩余 offset。
        const skip = page.remaining;
        let remaining = skip;
        let truncated = false;
        let cappedFiles: FileLocation[] = [];
        if (host.iterateFiles) {
            // 深分页只保留当前页；此前的路径逐项跳过，内存不随 offset 增长。
            for await (const file of host.iterateFiles(workspace.uri, pattern, exclude, skip + maxResults + 1, { includeIgnored })) {
                signal?.throwIfAborted();
                if (remaining > 0) { remaining--; continue; }
                if (cappedFiles.length >= maxResults) { truncated = true; break; }
                cappedFiles.push(file);
            }
        } else {
            const files = await host.findFiles(workspace.uri, pattern, exclude, skip + maxResults + 1, { includeIgnored });
            remaining = Math.max(0, skip - files.length);
            truncated = files.length > skip + maxResults;
            cappedFiles = files.slice(skip, skip + maxResults);
        }
        signal?.throwIfAborted();
        page.remaining = remaining;
        
        // 受控并发：以前用裸 Promise.all 对最多 500 个文件无上限并发全量读取，
        // 同时打开数百文件句柄且内存峰值不可控；行数统计本身也已改为字节流。
        const fileDetails = await mapWithConcurrency(cappedFiles, 8, async (fileUri: FileLocation): Promise<FoundFileDetail> => {
            signal?.throwIfAborted();
            const relativePath = host.toRelativePath(fileUri, includeWorkspacePrefix);
            const lineCount = await host.countLines(fileUri, relativePath);
            signal?.throwIfAborted();
            return {
                path: relativePath,
                lineCount
            };
        });
        fileDetails.sort((a, b) => a.path.localeCompare(b.path));
        const relativePaths = fileDetails.map(file => file.path);

        return {
            pattern,
            workspace: includeWorkspacePrefix ? workspace.name : undefined,
            success: true,
            files: relativePaths,
            fileDetails,
            count: relativePaths.length,
            truncated
        };
    } catch (error) {
        // 取消属于当前运行的控制流程，不能当成文件错误继续扫描后续模式或工作区。
        signal?.throwIfAborted();
        return {
            pattern,
            workspace: includeWorkspacePrefix ? workspace.name : undefined,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

async function findWithPattern(
    pattern: string,
    exclude: string,
    maxResults: number,
    offset: number,
    includeIgnored: boolean,
    signal?: AbortSignal
): Promise<FindResult> {
    const page = { remaining: offset };
    const workspaces = host.getAllWorkspaces();
    if (workspaces.length === 0) {
        return {
            pattern,
            success: false,
            error: 'No workspace folder open'
        };
    }
    
    // 单工作区模式
    if (workspaces.length === 1) {
        return findInWorkspace(workspaces[0], pattern, exclude, maxResults, false, page, includeIgnored, signal);
    }
    
    // 多工作区模式：在所有工作区中查找
    let allFiles: string[] = [];
    let allFileDetails: FoundFileDetail[] = [];
    let truncated = false;
    const workspaceErrors: { workspace: string; error: string }[] = [];
    
    for (const ws of workspaces) {
        signal?.throwIfAborted();
        // 修改原因：前置 allFiles.length >= maxResults 判断会在「后续工作区可能根本没有匹配文件」
        //           时误报 truncated（恰好累计到 maxResults 条但全库确实只有这么多）。
        // 修改方式：删除前置判断，每个工作区都走 maxResults+1 探测精确判定截断；
        //           remaining<=0 时探测仍能区分「该工作区还有文件（真截断）」与「没有文件（未截断）」。
        const remaining = maxResults - allFiles.length;
        const result = await findInWorkspace(ws, pattern, exclude, remaining, true, page, includeIgnored, signal);
        if (!result.success) {
            // 某根失败不能伪装成「全库无匹配」；保留其他根的结果，但不给出可能漏项的续查游标。
            workspaceErrors.push({ workspace: ws.name, error: result.error || 'File discovery failed' });
        }
        
        if (result.success && result.files) {
            allFiles.push(...result.files);
            // 修改原因：多工作区聚合时不能只合并旧的 files 数组，否则新增 lineCount 元数据会在该路径丢失。
            // 修改方式：同步合并每个工作区 result.fileDetails，并在最终返回前统一排序。
            // 修改目的：单工作区和多工作区 find_files 返回相同的信息层级。
            allFileDetails.push(...(result.fileDetails || []));
        }
        // 单个工作区内部已用 maxResults+1 探测精确判定截断，向上传播
        if (result.truncated) {
            truncated = true;
        }
    }
    
    allFiles.sort();
    allFileDetails.sort((a, b) => a.path.localeCompare(b.path));
    // 循环结束后统一封顶（防御性兜底）：正常情况下各工作区已按 remaining 精确封顶，
    // 此处仅在极端输入下保证返回条数不超 maxResults
    if (allFiles.length > maxResults) {
        allFiles = allFiles.slice(0, maxResults);
        allFileDetails = allFileDetails.slice(0, maxResults);
        truncated = true;
    }
    return {
        pattern,
        success: workspaceErrors.length === 0,
        workspaceErrors: workspaceErrors.length ? workspaceErrors : undefined,
        error: workspaceErrors.length ? `${workspaceErrors.length} workspace(s) failed to search` : undefined,
        files: allFiles,
        fileDetails: allFileDetails,
        count: allFiles.length,
        // 去掉原来的 allFiles.length >= maxResults 兜底：各工作区已用 maxResults+1 探测精确判定截断，
        // 恰好等于 maxResults 时不再误报 truncated
        truncated
    };
}

function createFindFilesTool(): Tool {
    const workspaces = host.getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
    const paginationNote = isZh
        ? '\n\n结果按模式分别分页，只在当前页内排序。某个模式返回 nextOffset 时，只传这个模式并把 nextOffset 作为 offset 传入，即可读取下一页，其他参数保持不变；文件或排除设置变化后从 offset=0 重新查询。实际生效的排除规则见结果中的 effectiveExclude、excludeSource 和 respectsGitIgnore。'
        : '\n\nResults are paged separately for each pattern and sorted only within a page. When a pattern returns nextOffset, pass just that pattern with nextOffset as offset to read the next page, keeping the other parameters unchanged; restart from offset 0 if files or exclusion settings change. effectiveExclude, excludeSource and respectsGitIgnore in the result show which exclusions were applied.';

    return {
        declaration: {
            name: 'find_files',
            readOnly: true,
            description: (isMultiRoot
                ? isZh
                    ? `按一个或多个 glob 模式查找文件。每个模式的结果在 fileDetails 中列出文件 path，能统计的文本文件还会带 lineCount（行数），可据此决定是否用 read_file 按行范围读取。当前是多根工作区，结果路径会带工作区名前缀。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
                    : `Find files matching one or more glob patterns. Each pattern lists file paths in fileDetails, and text files that can be counted also include lineCount, which helps you decide whether to read with a line range in read_file. This is a multi-root workspace, so result paths are prefixed with the workspace name. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`
                : isZh
                    ? '按一个或多个 glob 模式查找文件。每个模式的结果在 fileDetails 中列出文件 path，能统计的文本文件还会带 lineCount（行数），可据此决定是否用 read_file 按行范围读取。'
                    : 'Find files matching one or more glob patterns. Each pattern lists file paths in fileDetails, and text files that can be counted also include lineCount, which helps you decide whether to read with a line range in read_file.') + paginationNote,
            category: 'search',
            parameters: {
                type: 'object',
                properties: {
                    patterns: {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        description: isZh
                            ? 'glob 模式数组，例如 ["**/*.ts", "src/**/*.js"]。即使只有一个模式也要传数组，参数名是 patterns 而不是 pattern。'
                            : 'Array of glob patterns, for example ["**/*.ts", "src/**/*.js"]. Pass an array even for a single pattern; the parameter is patterns, not pattern.'
                    },
                    exclude: {
                        type: 'string',
                        // 非空 exclude 一直是覆盖而非追加；不能用 schema default 诱导模型覆盖用户配置。
                        description: isZh
                            ? '排除用的 glob，例如 "**/node_modules/**"。非空值会整体替换设置中的排除列表，而不是追加。省略或传空字符串时沿用设置；设置为空时默认排除 node_modules。'
                            : 'Exclusion glob, for example "**/node_modules/**". A nonempty value replaces the configured exclusion list instead of adding to it. When omitted or empty, the configured list is used; if that is empty, node_modules is excluded by default.'
                    },
                    includeIgnored: {
                        type: 'boolean', default: false,
                        description: isZh
                            ? `默认遵守排除设置${host.gitIgnoreSupported ? '和项目 .gitignore' : ''}。设为 true 会跳过这些忽略规则，但显式传入的 exclude 仍然生效${host.gitIgnoreSupported ? '，.git 元数据和符号链接也始终跳过' : ''}。`
                            : `By default, configured exclusions${host.gitIgnoreSupported ? ' and project .gitignore files' : ''} are respected. true skips those rules, but an explicit exclude still applies${host.gitIgnoreSupported ? ', and .git metadata and symlinks are always skipped' : ''}.`
                    },
                    maxResults: {
                        type: 'number',
                        description: isZh ? '每个模式每页最多返回的结果数。' : 'Maximum results per pattern per page.',
                        default: 500
                    },
                    offset: {
                        type: 'integer', minimum: 0, default: 0,
                        description: isZh
                            ? '每个模式要跳过的文件数。它不是排序后的序号，请只使用上一页返回的 nextOffset。'
                            : 'Number of files to skip for each pattern. It is not an index into sorted results, so only use a nextOffset returned by the previous page.'
                    }
                },
                required: ['patterns']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const signal = context?.abortSignal;
            signal?.throwIfAborted();
            const typed = parseArgs<FindFilesArgs>(args);
            // 支持 patterns 数组或单个 pattern（向后兼容）
            let patternList: string[] = [];
            
            if (typed.patterns && Array.isArray(typed.patterns)) {
                patternList = typed.patterns;
            } else if (typed.pattern && typeof typed.pattern === 'string') {
                // 向后兼容单个 pattern 参数
                patternList = [typed.pattern];
            }
            
            if (patternList.length === 0) {
                return { success: false, error: 'patterns is required' };
            }

            if (patternList.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
                return { success: false, error: 'patterns must contain non-empty strings' };
            }
            if (typed.exclude !== undefined && typeof typed.exclude !== 'string') {
                return { success: false, error: 'exclude must be a string' };
            }
            if (typed.includeIgnored !== undefined && typeof typed.includeIgnored !== 'boolean') {
                return { success: false, error: 'includeIgnored must be a boolean' };
            }
            const includeIgnored = typed.includeIgnored === true;
            const offset = typed.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) {
                return { success: false, error: 'offset must be a non-negative safe integer' };
            }
            // 保留 exclude='' 回退配置、非空值整体覆盖的旧约定，只补实际策略供模型核对。
            const configuredExcludes = host.findExcludePatterns();
            const exclude = typed.exclude || (includeIgnored ? '**/.git/**' : buildExcludePattern(configuredExcludes, DEFAULT_EXCLUDE_PATTERN));
            const excludeSource = typed.exclude ? 'argument' : includeIgnored ? 'includeIgnored' : configuredExcludes?.length ? 'settings' : 'fallback';
            // 小于 1 的正小数不能归零；Infinity/NaN 也不能传给宿主变成空结果或无界扫描。
            const maxResults = typeof typed.maxResults === 'number' && Number.isFinite(typed.maxResults) && typed.maxResults > 0
                ? Math.max(1, Math.floor(typed.maxResults)) : 500;
            if (!Number.isSafeInteger(offset + maxResults + 1)) {
                return { success: false, error: 'offset + maxResults + 1 must be a safe integer' };
            }

            const results: FindResult[] = [];
            let successCount = 0;
            let failCount = 0;
            let totalFiles = 0;

            for (const pattern of patternList) {
                signal?.throwIfAborted();
                const result = await findWithPattern(pattern, exclude, maxResults, offset, includeIgnored, signal);
                result.offset = offset;
                if (result.success && result.truncated) {
                    result.nextOffset = offset + (result.count || 0);
                    result.continuationHint = `Continue this pattern with offset=${result.nextOffset} and unchanged exclude. Pages follow host discovery order, then sort within each page; restart at offset=0 if files or settings changed.`;
                } else if (!result.success) {
                    result.continuationHint = 'Resolve the reported search errors, then restart this pattern at offset=0; partial results cannot provide a reliable continuation offset.';
                }
                results.push(result);
                // 部分工作区失败仍可能返回文件，汇总不能丢掉这些已展示结果。
                totalFiles += result.count || 0;
                
                if (result.success) {
                    successCount++;
                } else {
                    failCount++;
                }
            }

            const allSuccess = failCount === 0;
            return {
                success: allSuccess,
                data: {
                    results,
                    successCount,
                    failCount,
                    totalCount: patternList.length,
                    totalFiles,
                    effectiveExclude: exclude,
                    excludeSource,
                    includeIgnored,
                    respectsGitIgnore: !!host.gitIgnoreSupported && !includeIgnored
                },
                error: allSuccess ? undefined : `${failCount} patterns failed to search`
            };
        }
    };
}

function registerFindFiles(): Tool {
    return createFindFilesTool();
}
return {createFindFilesTool,registerFindFiles};
}
