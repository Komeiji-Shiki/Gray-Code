import * as path from 'path';
import type { Tool, ToolResult, ToolContext } from '../types';
import { mapWithConcurrency } from '../shared/concurrency';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
export interface FileLocation { fsPath: string }
export interface ListFilesHost {
getAllWorkspaces(): { name: string }[];
resolveUriWithInfo(file: string): { uri?: FileLocation; workspace?: {name:string}; relativePath: string; isExplicit: boolean; error?: string };
readDirectory(uri: FileLocation): Promise<[string, number][]>;
joinPath(uri: FileLocation, name: string): FileLocation;
countTextFileLines(uri: FileLocation, file: string): Promise<number | undefined>;
ignorePatterns(): string[] | undefined;
checkAccess(args: Record<string,unknown>|undefined, context?: ToolContext): string | null;
}
/** 原递归、忽略和结果装配完整保留，宿主只处理文件访问。 */
export function createListFilesTool(host: ListFilesHost): Tool {
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
function getIgnorePatterns(): string[] { return host.ignorePatterns() ?? DEFAULT_IGNORED; }

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
    uri: FileLocation;
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
    dirUri: FileLocation,
    basePath: string,
    entries: Entry[],
    ignorePatterns: string[],
    pendingLineCounts: PendingLineCount[],
    depth: number,
    state: RecursiveTraversalState,
    signal?: AbortSignal
): Promise<void> {
    // 深度上限：到达最大深度后不再下钻。该目录的条目已由父层记录，但其子内容未展开，
    // 结果不完整，标记 truncated 让模型知道可针对性列出子目录。
    if (depth >= MAX_RECURSIVE_DEPTH) {
        state.truncated = true;
        return;
    }
    signal?.throwIfAborted();
    const items = await host.readDirectory(dirUri);
    signal?.throwIfAborted();
    
    for (const [name, type] of items) {
        // 跳过忽略的目录和文件
        if (shouldIgnore(name, ignorePatterns) || (type !== 1 && type !== 2)) {
            continue;
        }
        if (type === 2 && RECURSIVE_SKIP_DIRS.some(skipDir => skipDir.toLowerCase() === name.toLowerCase())) continue;
        // 深度截断只影响当前子树；只有条目预算耗尽才停止后续兄弟目录。
        if (state.entryCount >= MAX_RECURSIVE_ENTRIES) {
            state.truncated = true;
            break;
        }
        
        // 统一使用 "/" 作为分隔符：path.join 在 Windows 上返回 "\\"，
        // 与其余工具（read_file 等）的 "/" 约定冲突，回传时解析失败。
        const relativePath = basePath ? `${basePath}/${name}` : name;
        
        if (type === 2) {
            entries.push({ name: relativePath + '/', type: 'directory' });
            state.entryCount++;
            // 递归进入子目录
            const subDirUri = host.joinPath(dirUri, name);
            await listDirectoryRecursive(subDirUri, relativePath, entries, ignorePatterns, pendingLineCounts, depth + 1, state, signal);
        } else if (type === 1) {
            const fileUri = host.joinPath(dirUri, name);
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
function createTool(): Tool {
    const workspaces = host.getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
    // 多根工作区的格式和可用名称只写在 paths 参数里，主说明不重复。
    let pathsDescription = isZh
        ? '要列出的目录路径数组，相对于工作区根目录。即使只有一个目录也要传数组，例如 ["src"]。'
        : 'Array of directory paths to list, relative to the workspace root. Pass an array even for a single directory, for example ["src"].';
    if (isMultiRoot) {
        pathsDescription = isZh
            ? `要列出的目录路径数组。当前是多根工作区，请使用 "workspace_name/path" 格式。即使只有一个目录也要传数组，例如 ["src"]。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `Array of directory paths to list. This is a multi-root workspace, so use the "workspace_name/path" format. Pass an array even for a single directory, for example ["src"]. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
    }
    
    return {
        declaration: {
            name: 'list_files',
            readOnly: true,
            description: isZh
                ? '列出一个或多个目录中的文件和子目录。文本文件的条目在能统计时会带 lineCount（行数），可据此决定是否用 read_file 按行范围读取。'
                : 'List files and subdirectories in one or more directories. Text file entries include lineCount when it can be counted, which helps you decide whether to read the file with a line range in read_file.',
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
                        description: isZh
                            ? '是否递归列出子目录。false 只列出直属的一层；true 递归列出全部内容，最大深度 10、最多 5000 个条目，超出时结果会被截断并标记 truncated。'
                            : 'Whether to list subdirectories recursively. false lists only the direct children; true lists everything below, up to depth 10 and 5000 entries, after which the result is cut off and marked truncated.',
                        default: false
                    }
                },
                required: ['paths']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            // 修改原因：list_files 接受绝对路径时可枚举工作区外目录内容，不受 outside-workspace 读策略管控。
            // 修改方式：与 read_file 一致，入口处调用 ensureOutsideWorkspaceAccessApproved（读策略 deny/ask/allow）。
            const accessError = host.checkAccess(args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

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

            const workspaces = host.getAllWorkspaces();
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
                    context?.abortSignal?.throwIfAborted();
                    const { uri: dirUri, workspace, relativePath, isExplicit } = host.resolveUriWithInfo(dirPath);
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
                        await listDirectoryRecursive(dirUri, '', entries, ignorePatterns, pendingLineCounts, 0, state, context?.abortSignal);
                        truncated = state.truncated;
                    } else {
                        // 只列出顶层
                        const items = await host.readDirectory(dirUri);
                        
                        for (const [name, type] of items) {
                            // 跳过忽略的目录和文件
                            if (shouldIgnore(name, ignorePatterns) || (type !== 1 && type !== 2)) {
                                continue;
                            }

                            // 非递归模式条目上限：巨型目录顶层条目也可能无界，
                            // 与递归模式共用预算，超出后停止收集并标记 truncated
                            if (entries.length >= MAX_RECURSIVE_ENTRIES) {
                                truncated = true;
                                break;
                            }
                            
                            if (type === 2) {
                                entries.push({ name: name + '/', type: 'directory' });
                            } else if (type === 1) {
                                const fileUri = host.joinPath(dirUri, name);
                                const entry: Entry = { name, type: 'file' };
                                entries.push(entry);
                                pendingLineCounts.push({ entry, uri: fileUri, filePath: name });
                            }
                        }
                    }

                    // 受控并发填充行数：替代遍历循环里的逐文件串行 await
                    await mapWithConcurrency(pendingLineCounts, LINE_COUNT_CONCURRENCY, async pending => {
                        context?.abortSignal?.throwIfAborted();
                        pending.entry.lineCount = await host.countTextFileLines(pending.uri, pending.filePath);
                        context?.abortSignal?.throwIfAborted();
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
                    context?.abortSignal?.throwIfAborted();
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

return createTool();
}
