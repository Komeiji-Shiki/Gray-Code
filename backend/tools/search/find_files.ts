/**
 * 查找文件工具
 *
 * 支持单个或多个 glob 模式查找
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import { parseArgs } from '../types';
import { getWorkspaceRoot, getAllWorkspaces, toRelativePath, countTextFileLines, mapWithConcurrency } from '../utils';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildExcludePattern, DEFAULT_EXCLUDE_PATTERN } from '../shared/globUtils';

/**
 * 获取排除模式
 *
 * 从设置管理器获取用户配置的排除模式，如果未配置则使用默认值
 * 将多个模式合并为单个 glob 模式（用大括号语法）。
 * 实现已收敛到 shared/globUtils.buildExcludePattern（发现 11）。
 */
function getExcludePattern(): string {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager ? settingsManager.getFindFilesConfig() : undefined;
    return buildExcludePattern(config?.excludePatterns, DEFAULT_EXCLUDE_PATTERN);
}

/**
 * 单个模式的查找结果
 */
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
    error?: string;
}

/**
 * find_files 的规范化参数形状（pattern 为向后兼容字段）。
 */
interface FindFilesArgs {
    patterns?: string[];
    pattern?: string;
    exclude?: string;
    maxResults?: number;
}

/**
 * 在单个工作区中执行模式查找
 */
async function findInWorkspace(
    workspace: { name: string; uri: vscode.Uri },
    pattern: string,
    exclude: string,
    maxResults: number,
    includeWorkspacePrefix: boolean
): Promise<FindResult> {
    try {
        // 创建相对于工作区的模式
        const relativePattern = new vscode.RelativePattern(workspace.uri, pattern);
        // 多取 1 个用于精确判定截断：findFiles 达到 maxResults 即停止，无法区分
        // “恰好 maxResults 个”与“超过 maxResults 个”；取 maxResults+1 后若多出 1 个
        // 才说明真的被截断，避免恰好等于时误报 truncated
        const files = await vscode.workspace.findFiles(relativePattern, exclude, maxResults + 1);
        const truncated = files.length > maxResults;
        const cappedFiles = truncated ? files.slice(0, maxResults) : files;
        
        // 受控并发：以前用裸 Promise.all 对最多 500 个文件无上限并发全量读取，
        // 同时打开数百文件句柄且内存峰值不可控；行数统计本身也已改为字节流。
        const fileDetails = await mapWithConcurrency(cappedFiles, 8, async (fileUri: vscode.Uri): Promise<FoundFileDetail> => {
            const relativePath = toRelativePath(fileUri, includeWorkspacePrefix);
            return {
                path: relativePath,
                lineCount: await countTextFileLines(fileUri, relativePath)
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

/**
 * 执行单个模式的查找（支持多工作区）
 */
async function findWithPattern(
    pattern: string,
    exclude: string,
    maxResults: number
): Promise<FindResult> {
    const workspaces = getAllWorkspaces();
    if (workspaces.length === 0) {
        return {
            pattern,
            success: false,
            error: 'No workspace folder open'
        };
    }
    
    // 单工作区模式
    if (workspaces.length === 1) {
        return findInWorkspace(workspaces[0], pattern, exclude, maxResults, false);
    }
    
    // 多工作区模式：在所有工作区中查找
    let allFiles: string[] = [];
    let allFileDetails: FoundFileDetail[] = [];
    let truncated = false;
    
    for (const ws of workspaces) {
        // 修改原因：前置 allFiles.length >= maxResults 判断会在「后续工作区可能根本没有匹配文件」
        //           时误报 truncated（恰好累计到 maxResults 条但全库确实只有这么多）。
        // 修改方式：删除前置判断，每个工作区都走 maxResults+1 探测精确判定截断；
        //           remaining<=0 时探测仍能区分「该工作区还有文件（真截断）」与「没有文件（未截断）」。
        const remaining = maxResults - allFiles.length;
        const result = await findInWorkspace(ws, pattern, exclude, remaining, true);
        
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
        success: true,
        files: allFiles,
        fileDetails: allFileDetails,
        count: allFiles.length,
        // 去掉原来的 allFiles.length >= maxResults 兜底：各工作区已用 maxResults+1 探测精确判定截断，
        // 恰好等于 maxResults 时不再误报 truncated
        truncated
    };
}

/**
 * 创建查找文件工具
 */
export function createFindFilesTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
    const arrayFormatNote = isZh
        ? '\n\n重要：patterns 参数必须是数组，即使只有一个模式也要写成 {"patterns": ["*.ts"]}，不要写成 {"pattern": "*.ts"}。'
        : '\n\nImportant: the patterns parameter must be an array, even for a single pattern, e.g., {"patterns": ["*.ts"]}, NOT {"pattern": "*.ts"}.';

    return {
        declaration: {
            name: 'find_files',
            readOnly: true,
            // 修改原因：用户要求 find_files 与 list_files 的新工具描述统一改为中文，并强调新增 lineCount 元数据。
            // 修改方式：主描述说明 glob、fileDetails.lineCount、数组参数和多根工作区规则，参数描述也同步中文化。
            // 修改目的：减少中文会话中模型误用 pattern 单字符串或忽略行数元数据的概率。
            description: isMultiRoot
                ? isZh
                    ? `根据一个或多个 glob 模式查找文件。结果会保留 files 字符串数组，并额外返回 fileDetails；其中可统计的文本文件会带 lineCount 行数，便于决定是否用 read_file 范围读取。当前是多根工作区，结果会带工作区前缀。可用工作区：${workspaces.map(w => w.name).join(', ')}。${arrayFormatNote}`
                    : `Find files by one or more glob patterns. The result keeps the files string array and additionally returns fileDetails; text files that can be counted include a lineCount, to help decide whether to use read_file with a line range. This is a multi-root workspace, so results are prefixed with the workspace name. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.${arrayFormatNote}`
                : isZh
                    ? `根据一个或多个 glob 模式查找文件。结果会保留 files 字符串数组，并额外返回 fileDetails；其中可统计的文本文件会带 lineCount 行数，便于决定是否用 read_file 范围读取。${arrayFormatNote}`
                    : `Find files by one or more glob patterns. The result keeps the files string array and additionally returns fileDetails; text files that can be counted include a lineCount, to help decide whether to use read_file with a line range.${arrayFormatNote}`,
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
                        description: isZh
                            ? '排除模式，例如："**/node_modules/**"。'
                            : 'Exclude pattern, e.g., "**/node_modules/**".',
                        default: '**/node_modules/**'
                    },
                    maxResults: {
                        type: 'number',
                        description: isZh ? '每个模式最多返回多少个结果。' : 'Maximum number of results returned per pattern.',
                        default: 500
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

            // 如果用户指定了 exclude 参数则使用，否则使用配置的默认值
            const exclude = typed.exclude || getExcludePattern();
            // 0/负值/非数字语义混乱（负值会原样传入 findFiles）：统一回退到默认 500，并取整
            const maxResults = typeof typed.maxResults === 'number' && typed.maxResults > 0 ? Math.floor(typed.maxResults) : 500;

            const results: FindResult[] = [];
            let successCount = 0;
            let failCount = 0;
            let totalFiles = 0;

            for (const pattern of patternList) {
                const result = await findWithPattern(pattern, exclude, maxResults);
                results.push(result);
                
                if (result.success) {
                    successCount++;
                    totalFiles += result.count || 0;
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
                    totalFiles
                },
                error: allSuccess ? undefined : `${failCount} patterns failed to search`
            };
        }
    };
}

/**
 * 注册查找文件工具
 */
export function registerFindFiles(): Tool {
    return createFindFilesTool();
}
