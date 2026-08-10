/**
 * 列出文件工具
 *
 * 支持列出单个或多个目录，同时返回文件和子目录
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { getWorkspaceRoot, resolveUri, getAllWorkspaces, parseWorkspacePath, resolveUriWithInfo, countTextFileLines, mapWithConcurrency } from '../utils';
import { getGlobalSettingsManager } from '../../core/settingsContext';

/**
 * 默认忽略的目录和文件
 */
const DEFAULT_IGNORED = ['.git'];

/**
 * 递归列出的最大深度（0 表示只列根目录直属一层；到达深度后不再下钻）
 */
const MAX_RECURSIVE_DEPTH = 10;

/**
 * 递归列出收集的条目总数上限（文件 + 目录）；达到上限后停止收集并标记 truncated。
 *
 * 修改原因：递归无深度/条目上限时，巨型目录树耗时与输出均无界，
 * 且每个文本文件还要并发读流统计行数。
 * 修改方式：与 find_files/fileTree 的预算截断惯例一致，超出后置 truncated 标志。
 */
const MAX_RECURSIVE_ENTRIES = 5000;

/**
 * 递归遍历时额外跳过的常见巨型目录。
 *
 * 修改原因：默认忽略列表只有 .git，用户未配置自定义忽略时，
 * node_modules/dist 等巨型目录会被整树遍历，递归无界。
 * 修改方式：仅在递归下钻时跳过（不影响非递归的顶层显式列出）。
 */
const RECURSIVE_SKIP_DIRS = ['.git', 'node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.cache'];

/**
 * 递归遍历共享状态：条目计数与截断标志
 */
interface RecursiveTraversalState {
    /** 已收集的条目数（文件 + 目录） */
    entryCount: number;
    /** 是否因深度/条目上限被截断 */
    truncated: boolean;
}

/**
 * 获取忽略列表
 *
 * 从设置管理器获取用户配置的忽略列表，如果未配置则使用默认值
 */
function getIgnorePatterns(): string[] {
    const settingsManager = getGlobalSettingsManager();
    if (settingsManager) {
        const config = settingsManager.getListFilesConfig();
        return config.ignorePatterns || DEFAULT_IGNORED;
    }
    return DEFAULT_IGNORED;
}

/**
 * 检查是否应该忽略
 *
 * 支持通配符匹配：
 * - *.ext 匹配任意以 .ext 结尾的文件
 * - prefix* 匹配任意以 prefix 开头的文件
 * - 精确匹配
 */
function shouldIgnore(name: string, ignorePatterns: string[]): boolean {
    for (const pattern of ignorePatterns) {
        // 通配符匹配
        if (pattern === '*') {
            // 忽略全部条目
            return true;
        }
        if (pattern.startsWith('*') && pattern.length > 1) {
            // *.ext 匹配
            const suffix = pattern.slice(1);
            if (name.endsWith(suffix)) {
                return true;
            }
        } else if (pattern.endsWith('*') && pattern.length > 1) {
            // prefix* 匹配
            const prefix = pattern.slice(0, -1);
            if (name.startsWith(prefix)) {
                return true;
            }
        } else {
            // 精确匹配
            if (name === pattern) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 条目类型
 */
interface Entry {
    name: string;
    type: 'file' | 'directory';
    /**
     * 文本文件行数；目录和二进制文件不提供。
     *
     * 修改原因：模型在决定是否直接 read_file 时需要知道文件规模，只看文件名会诱发读取超大文件。
     * 修改方式：list_files 生成文件 entry 时尝试统计文本行数，失败或二进制文件保持 undefined。
     * 修改目的：让目录浏览结果具备足够的读取决策信息，同时不破坏既有 name/type 字段。
     */
    lineCount?: number;
}

/**
 * 待填充行数的文件条目（遍历阶段收集，遍历完成后受控并发统计）。
 *
 * 修改原因：以前在目录遍历循环里逐个 await countTextFileLines，
 * 递归列出大目录时等于串行把整个目录树的文件读一遍。
 */
interface PendingLineCount {
    entry: Entry;
    uri: vscode.Uri;
    filePath: string;
}

/** 行数统计的并发上限 */
const LINE_COUNT_CONCURRENCY = 8;

/**
 * 单个目录的列出结果
 */
interface ListResult {
    path: string;
    workspace?: string;
    entries: Entry[];
    fileCount: number;
    dirCount: number;
    success: boolean;
    /** 递归列出时是否因深度/条目上限被截断 */
    truncated?: boolean;
    error?: string;
}

/**
 * 递归列出目录内容
 */
async function listDirectoryRecursive(
    dirUri: vscode.Uri,
    basePath: string,
    entries: Entry[],
    ignorePatterns: string[],
    pendingLineCounts: PendingLineCount[],
    depth: number,
    state: RecursiveTraversalState
): Promise<void> {
    // 深度上限：到达最大深度后不再下钻。该目录的条目已由父层记录，但其子内容未展开，
    // 结果不完整，标记 truncated 让模型知道可针对性列出子目录。
    if (depth >= MAX_RECURSIVE_DEPTH) {
        state.truncated = true;
        return;
    }
    if (state.truncated) {
        return;
    }

    const items = await vscode.workspace.fs.readDirectory(dirUri);
    
    for (const [name, type] of items) {
        // 条目总数上限：预算已满且仍有未处理条目，停止收集并标记截断
        if (state.entryCount >= MAX_RECURSIVE_ENTRIES) {
            state.truncated = true;
            break;
        }
        
        // 跳过忽略的目录和文件
        if (shouldIgnore(name, ignorePatterns)) {
            continue;
        }
        
        // 统一使用 "/" 作为分隔符：path.join 在 Windows 上返回 "\\"，
        // 与其余工具（read_file 等）的 "/" 约定冲突，回传时解析失败。
        const relativePath = basePath ? `${basePath}/${name}` : name;
        
        if (type === vscode.FileType.Directory) {
            // 跳过常见巨型目录，防止递归无界（不影响非递归的顶层显式列出）。
            // 目录名比较转小写：Windows/macOS 文件系统大小写不敏感，
            // 避免 NodeModules / Dist 等大小写变体漏网被整树遍历。
            if (RECURSIVE_SKIP_DIRS.some(skipDir => skipDir.toLowerCase() === name.toLowerCase())) {
                continue;
            }
            entries.push({ name: relativePath + '/', type: 'directory' });
            state.entryCount++;
            // 递归进入子目录
            const subDirUri = vscode.Uri.joinPath(dirUri, name);
            await listDirectoryRecursive(subDirUri, relativePath, entries, ignorePatterns, pendingLineCounts, depth + 1, state);
        } else if (type === vscode.FileType.File) {
            const fileUri = vscode.Uri.joinPath(dirUri, name);
            // 行数不在遍历循环里逐个 await，而是收集后统一受控并发填充
            const entry: Entry = { name: relativePath, type: 'file' };
            entries.push(entry);
            state.entryCount++;
            pendingLineCounts.push({ entry, uri: fileUri, filePath: relativePath });
        }
    }
}

/**
 * 创建列出文件工具
 */
export function createListFilesTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 数组格式强调说明
    // 修改原因：用户要求两个文件发现类工具的新描述统一使用中文，同时保留数组参数约束，降低模型把 path 写成字符串的概率。
    // 修改方式：将主描述和参数描述改为中文，并明确文件 entry 会携带 lineCount。
    // 修改目的：让模型在中文对话中更容易理解 list_files 的批量目录语义和行数元数据。
    const arrayFormatNote = '。即使只列出一个目录，也必须传数组，例如：["src"]。';
    
    let pathsDescription = '要列出的目录路径数组，相对于当前工作区根目录' + arrayFormatNote;
    if (isMultiRoot) {
        pathsDescription = `要列出的目录路径数组；当前是多根工作区，必须使用 "workspace_name/path" 格式${arrayFormatNote}可用工作区：${workspaces.map(w => w.name).join(', ')}。`;
    }
    
    return {
        declaration: {
            name: 'list_files',
            readOnly: true,
            description: isMultiRoot
                ? `列出一个或多个目录中的文件和子目录。文件条目在可统计时会包含 lineCount（文本文件行数），便于决定是否用 read_file 范围读取。当前是多根工作区，path 必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
                : '列出一个或多个目录中的文件和子目录，支持批量列出。文件条目在可统计时会包含 lineCount（文本文件行数），便于决定是否用 read_file 范围读取。',
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    paths: {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        description: pathsDescription
                    },
                    recursive: {
                        type: 'boolean',
                        description: '是否递归列出子目录。false 时只列出指定目录直属的一层；true 时递归列出所有子目录内容（最大深度 10、最多 5000 个条目，超出后截断并置 truncated）。',
                        default: false
                    }
                },
                required: ['paths']
            }
        },
        handler: async (args): Promise<ToolResult> => {
            // 支持 paths 数组或单个 path（向后兼容）
            let pathList: string[] = [];
            
            if (args.paths && Array.isArray(args.paths)) {
                pathList = args.paths as string[];
            } else if (args.path && typeof args.path === 'string') {
                // 向后兼容单个 path 参数
                pathList = [args.path];
            }
            
            if (pathList.length === 0) {
                pathList = ['.']; // 默认为根目录
            }
            
            const recursive = (args.recursive as boolean) || false;

            const workspaces = getAllWorkspaces();
            if (workspaces.length === 0) {
                return { success: false, error: 'No workspace folder open' };
            }
            
            const isMultiRoot = workspaces.length > 1;

            // 获取忽略列表配置
            const ignorePatterns = getIgnorePatterns();

            const results: ListResult[] = [];
            let totalFiles = 0;
            let totalDirs = 0;

            for (const dirPath of pathList) {
                try {
                    const { uri: dirUri, workspace, relativePath, isExplicit } = resolveUriWithInfo(dirPath);
                    if (!dirUri) {
                        results.push({
                            path: dirPath,
                            entries: [],
                            fileCount: 0,
                            dirCount: 0,
                            success: false,
                            error: 'No workspace folder open'
                        });
                        continue;
                    }
                    
                    const entries: Entry[] = [];
                    const pendingLineCounts: PendingLineCount[] = [];
                    
                    // 递归结果是否被截断（深度/条目上限）
                    let truncated = false;

                    if (recursive) {
                        // 递归列出（带深度与条目上限，超出即截断）
                        const state: RecursiveTraversalState = { entryCount: 0, truncated: false };
                        await listDirectoryRecursive(dirUri, '', entries, ignorePatterns, pendingLineCounts, 0, state);
                        truncated = state.truncated;
                    } else {
                        // 只列出顶层
                        const items = await vscode.workspace.fs.readDirectory(dirUri);
                        
                        for (const [name, type] of items) {
                            // 跳过忽略的目录和文件
                            if (shouldIgnore(name, ignorePatterns)) {
                                continue;
                            }

                            // 非递归模式条目上限：巨型目录顶层条目也可能无界，
                            // 与递归模式共用预算，超出后停止收集并标记 truncated
                            if (entries.length >= MAX_RECURSIVE_ENTRIES) {
                                truncated = true;
                                break;
                            }
                            
                            if (type === vscode.FileType.Directory) {
                                entries.push({ name: name + '/', type: 'directory' });
                            } else if (type === vscode.FileType.File) {
                                const fileUri = vscode.Uri.joinPath(dirUri, name);
                                const entry: Entry = { name, type: 'file' };
                                entries.push(entry);
                                pendingLineCounts.push({ entry, uri: fileUri, filePath: name });
                            }
                        }
                    }

                    // 受控并发填充行数：替代遍历循环里的逐文件串行 await
                    await mapWithConcurrency(pendingLineCounts, LINE_COUNT_CONCURRENCY, async pending => {
                        pending.entry.lineCount = await countTextFileLines(pending.uri, pending.filePath);
                    });
                    
                    // 排序：目录在前，文件在后，各自按名称排序
                    entries.sort((a, b) => {
                        if (a.type !== b.type) {
                            return a.type === 'directory' ? -1 : 1;
                        }
                        return a.name.localeCompare(b.name);
                    });
                    
                    const fileCount = entries.filter(e => e.type === 'file').length;
                    const dirCount = entries.filter(e => e.type === 'directory').length;

                    results.push({
                        path: dirPath,
                        workspace: isMultiRoot ? workspace?.name : undefined,
                        entries,
                        fileCount,
                        dirCount,
                        success: true,
                        truncated
                    });
                    totalFiles += fileCount;
                    totalDirs += dirCount;
                } catch (error) {
                    results.push({
                        path: dirPath,
                        entries: [],
                        fileCount: 0,
                        dirCount: 0,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            const allSuccess = results.every(r => r.success);
            return {
                success: allSuccess,
                data: {
                    results,
                    totalFiles,
                    totalDirs,
                    totalPaths: pathList.length
                },
                error: allSuccess ? undefined : 'Some directories failed to list'
            };
        }
    };
}

/**
 * 注册列出文件工具
 */
export function registerListFiles(): Tool {
    return createListFilesTool();
}