import type { Tool, ToolResult } from '../types';
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
    page: { remaining: number }
): Promise<FindResult> {
    try {
        // offset 先按宿主发现顺序跳过，再保持旧的页内排序；不能先全局排序，
        // 否则会改变首批结果与已有遍历预算。只统计本页行数，不重读已跳过文件。
        // 多取 1 个仅用于精确判定截断，跨工作区共享剩余 offset。
        const skip = page.remaining;
        const files = await host.findFiles(workspace.uri, pattern, exclude, skip + maxResults + 1);
        page.remaining = Math.max(0, skip - files.length);
        const truncated = files.length > skip + maxResults;
        const cappedFiles = files.slice(skip, skip + maxResults);
        
        // 受控并发：以前用裸 Promise.all 对最多 500 个文件无上限并发全量读取，
        // 同时打开数百文件句柄且内存峰值不可控；行数统计本身也已改为字节流。
        const fileDetails = await mapWithConcurrency(cappedFiles, 8, async (fileUri: FileLocation): Promise<FoundFileDetail> => {
            const relativePath = host.toRelativePath(fileUri, includeWorkspacePrefix);
            return {
                path: relativePath,
                lineCount: await host.countLines(fileUri, relativePath)
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
    offset: number
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
        return findInWorkspace(workspaces[0], pattern, exclude, maxResults, false, page);
    }
    
    // 多工作区模式：在所有工作区中查找
    let allFiles: string[] = [];
    let allFileDetails: FoundFileDetail[] = [];
    let truncated = false;
    const workspaceErrors: { workspace: string; error: string }[] = [];
    
    for (const ws of workspaces) {
        // 修改原因：前置 allFiles.length >= maxResults 判断会在「后续工作区可能根本没有匹配文件」
        //           时误报 truncated（恰好累计到 maxResults 条但全库确实只有这么多）。
        // 修改方式：删除前置判断，每个工作区都走 maxResults+1 探测精确判定截断；
        //           remaining<=0 时探测仍能区分「该工作区还有文件（真截断）」与「没有文件（未截断）」。
        const remaining = maxResults - allFiles.length;
        const result = await findInWorkspace(ws, pattern, exclude, remaining, true, page);
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
    
    const arrayFormatNote = isZh
        ? '\n\n重要：patterns 参数必须是数组，即使只有一个模式也要写成 {"patterns": ["*.ts"]}，不要写成 {"pattern": "*.ts"}。'
        : '\n\nImportant: the patterns parameter must be an array, even for a single pattern, e.g., {"patterns": ["*.ts"]}, NOT {"pattern": "*.ts"}.';

    const paginationNote = isZh
        ? '\n每个模式含 nextOffset 时可作为 offset 续查。offset 按宿主发现顺序跳过，结果仅页内排序；不同宿主顺序可能不同，每页重新遍历，文件或排除设置变化后从 0 重查。排除策略见 effectiveExclude/excludeSource；不保证遵循 .gitignore。'
        : '\nContinue each pattern with its nextOffset as offset. Offset skips host discovery order; only each page is sorted. Host order may differ and each page rescans live files; restart at 0 after files or exclusion settings change. See effectiveExclude/excludeSource for exclusions; .gitignore filtering is not guaranteed.';

    return {
        declaration: {
            name: 'find_files',
            readOnly: true,
            // 修改原因：用户要求 find_files 与 list_files 的新工具描述统一改为中文，并强调新增 lineCount 元数据。
            // 修改方式：主描述说明 glob、fileDetails.lineCount、数组参数和多根工作区规则，参数描述也同步中文化。
            // 修改目的：减少中文会话中模型误用 pattern 单字符串或忽略行数元数据的概率。
            description: (isMultiRoot
                ? isZh
                    ? `根据一个或多个 glob 模式查找文件。结果会保留 files 字符串数组，并额外返回 fileDetails；其中可统计的文本文件会带 lineCount 行数，便于决定是否用 read_file 范围读取。当前是多根工作区，结果会带工作区前缀。可用工作区：${workspaces.map(w => w.name).join(', ')}。${arrayFormatNote}`
                    : `Find files by one or more glob patterns. The result keeps the files string array and additionally returns fileDetails; text files that can be counted include a lineCount, to help decide whether to use read_file with a line range. This is a multi-root workspace, so results are prefixed with the workspace name. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.${arrayFormatNote}`
                : isZh
                    ? `根据一个或多个 glob 模式查找文件。结果会保留 files 字符串数组，并额外返回 fileDetails；其中可统计的文本文件会带 lineCount 行数，便于决定是否用 read_file 范围读取。${arrayFormatNote}`
                    : `Find files by one or more glob patterns. The result keeps the files string array and additionally returns fileDetails; text files that can be counted include a lineCount, to help decide whether to use read_file with a line range.${arrayFormatNote}`) + paginationNote,
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
                            ? '要搜索的 glob 模式数组。即使只有一个模式也必须传数组，例如：["**/*.ts", "src/**/*.js"]。'
                            : 'Array of glob patterns to search. Even a single pattern must be passed as an array, e.g., ["**/*.ts", "src/**/*.js"].'
                    },
                    exclude: {
                        type: 'string',
                        // 非空 exclude 一直是覆盖而非追加；不能用 schema default 诱导模型覆盖用户配置。
                        description: isZh
                            ? '非空 glob 整体替换设置中的排除列表（不是追加），例如："**/node_modules/**"。省略或传空字符串沿用设置；未配置/空列表时回退排除 node_modules。不会自动合并 .gitignore。'
                            : 'A nonempty glob replaces the configured exclusions (not appended), e.g., "**/node_modules/**". Omitted or empty string uses settings; missing/empty settings fall back to excluding node_modules. Does not automatically merge .gitignore.'
                    },
                    maxResults: {
                        type: 'number',
                        description: isZh ? '每个模式每页最多返回多少个结果。' : 'Maximum number of results returned per pattern per page.',
                        default: 500
                    },
                    offset: {
                        type: 'integer', minimum: 0, default: 0,
                        description: isZh
                            ? '每个模式按发现顺序跳过的文件数（多根累计，不是排序后的索引）。续查建议只传对应的单个模式及其 nextOffset，保持 exclude 不变；文件/设置变化后从 0 重查。'
                            : 'Files to skip in discovery order per pattern (across roots, not a sorted index). Continue one pattern with its nextOffset and unchanged exclude; restart at 0 after files/settings change.'
                    }
                },
                required: ['patterns']
            }
        },
        handler: async (args): Promise<ToolResult> => {
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
            const offset = typed.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) {
                return { success: false, error: 'offset must be a non-negative safe integer' };
            }
            // 保留 exclude='' 回退配置、非空值整体覆盖的旧约定，只补实际策略供模型核对。
            const configuredExcludes = host.findExcludePatterns();
            const exclude = typed.exclude || buildExcludePattern(configuredExcludes, DEFAULT_EXCLUDE_PATTERN);
            const excludeSource = typed.exclude ? 'argument' : configuredExcludes?.length ? 'settings' : 'fallback';
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
                const result = await findWithPattern(pattern, exclude, maxResults, offset);
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
                    excludeSource
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
