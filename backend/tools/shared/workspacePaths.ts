// 从 utils.ts 拆分而来（多工作区路径解析）

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { t } from '../../i18n';
import { IS_WINDOWS } from './textUtils';

// TODO(02#05): `(fs as any).realpathSync?.native` 访问 fs 的 native 绑定（@types/node 未声明），
// 且测试环境可能 mock 掉 realpathSync；保留 as any 并做运行时可选链守卫。

// ==================== 多工作区支持 ====================

/**
 * 工作区信息
 */
export interface WorkspaceInfo {
    /** 工作区名称 */
    name: string;
    /** 工作区 URI */
    uri: vscode.Uri;
    /** 工作区文件系统路径 */
    fsPath: string;
    /** 索引（在 workspaceFolders 中的位置） */
    index: number;
}

/**
 * 获取所有工作区
 */
export function getAllWorkspaces(): WorkspaceInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    
    return folders.map((folder, index) => ({
        name: folder.name,
        uri: folder.uri,
        fsPath: folder.uri.fsPath,
        index
    }));
}

/**
 * 获取工作区根目录（默认返回第一个工作区，保持向后兼容）
 */
export function getWorkspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * 根据名称或索引获取工作区
 *
 * @param identifier 工作区名称或索引
 * @returns 工作区信息，如果未找到则返回 undefined
 */
export function getWorkspaceByIdentifier(identifier: string | number): WorkspaceInfo | undefined {
    const workspaces = getAllWorkspaces();
    
    if (typeof identifier === 'number') {
        return workspaces[identifier];
    }
    
    // 按名称查找（不区分大小写）
    return workspaces.find(w => w.name.toLowerCase() === identifier.toLowerCase());
}

/**
 * 解析带工作区前缀的路径
 *
 * 支持格式：
 * - `workspace_name/path/to/file` - 工作区名称前缀带路径
 * - `workspace_name` - 只有工作区名称（访问根目录）
 * - `@workspace_name/path/to/file` - @ 前缀格式带路径
 * - `@workspace_name` - @ 前缀只有工作区名称（访问根目录）
 *
 * 单工作区时：直接使用该工作区
 * 多工作区时：必须显式指定工作区前缀
 *
 * @param pathStr 路径字符串
 * @returns 解析结果，包含工作区信息和相对路径
 */
export function parseWorkspacePath(pathStr: string): {
    workspace: WorkspaceInfo | undefined;
    relativePath: string;
    isExplicit: boolean;  // 是否显式指定了工作区
    error?: string;       // 错误信息
} {
    const workspaces = getAllWorkspaces();
    
    // 如果没有工作区
    if (workspaces.length === 0) {
        return { workspace: undefined, relativePath: pathStr, isExplicit: false, error: 'No workspace folder open' };
    }
    
    // 如果只有一个工作区，直接返回
    if (workspaces.length === 1) {
        return { workspace: workspaces[0], relativePath: pathStr, isExplicit: false };
    }
    
    // 多工作区模式，必须显式指定前缀
    
    // 处理 @ 前缀格式
    if (pathStr.startsWith('@')) {
        const slashIndex = pathStr.indexOf('/');
        if (slashIndex > 1) {
            // @workspace_name/path 格式
            const workspaceName = pathStr.substring(1, slashIndex);
            const relativePath = pathStr.substring(slashIndex + 1);
            const workspace = getWorkspaceByIdentifier(workspaceName);
            if (workspace) {
                return { workspace, relativePath, isExplicit: true };
            }
            return {
                workspace: undefined,
                relativePath: pathStr,
                isExplicit: false,
                error: `Unknown workspace: ${workspaceName}. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`
            };
        } else {
            // @workspace_name 格式（没有路径，访问根目录）
            const workspaceName = pathStr.substring(1);
            const workspace = getWorkspaceByIdentifier(workspaceName);
            if (workspace) {
                return { workspace, relativePath: '.', isExplicit: true };
            }
            return {
                workspace: undefined,
                relativePath: pathStr,
                isExplicit: false,
                error: `Unknown workspace: ${workspaceName}. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`
            };
        }
    }
    
    // 检查是否以工作区名称开头（带 /）
    for (const workspace of workspaces) {
        const prefix = workspace.name + '/';
        if (pathStr.startsWith(prefix)) {
            return {
                workspace,
                relativePath: pathStr.substring(prefix.length),
                isExplicit: true
            };
        }
    }
    
    // 检查是否精确匹配工作区名称（不带 /，访问根目录）
    for (const workspace of workspaces) {
        if (pathStr === workspace.name) {
            return {
                workspace,
                relativePath: '.',
                isExplicit: true
            };
        }
    }
    
    // 多工作区时未指定前缀，返回错误
    return {
        workspace: undefined,
        relativePath: pathStr,
        isExplicit: false,
        error: `Multi-root workspace requires workspace prefix. Use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`
    };
}

/**
 * 判断字符串是否是本地绝对路径或文件 URI。
 *
 * 仅将明确的绝对路径视为工作区外访问入口；普通相对路径仍按工作区路径解析。
 */
export function isAbsoluteFilePathLike(pathStr: string): boolean {
    const trimmed = pathStr.trim();
    if (!trimmed) {
        return false;
    }

    if (trimmed.startsWith('file://')) {
        return true;
    }

    if (path.isAbsolute(trimmed)) {
        return true;
    }

    return /^[a-zA-Z]:[/\\]/.test(trimmed) || /^[/\\]{2}[^/\\]+[/\\]+[^/\\]+/.test(trimmed);
}

/**
 * 将输入路径解析为本地文件 URI。
 */
export function toFileUri(pathStr: string): vscode.Uri {
    const trimmed = pathStr.trim();
    if (trimmed.startsWith('file://')) {
        return vscode.Uri.parse(trimmed);
    }
    return vscode.Uri.file(trimmed);
}

/**
 * 将路径解析为用于比较的规范绝对路径（realpath-aware）。
 *
 * 修改原因：旧比较只做词法规范化（path.resolve + 字符串前缀比较），工作区内指向工作区外的
 * 符号链接会通过词法前缀比较被误判为“在工作区内”，绕过 deny/ask 策略
 * （read_file/write_file/delete_file 等的 outside-workspace 判定链共用 normalizePathForComparison）。
 * 修改方式：对路径本身（或其最近的存在祖先）做 fs.realpathSync.native 解析后，再拼接不存在的
 * 尾部段，把解析结果用于前缀比较；不存在/无权限/符号链接循环/realpath 实现缺失（如测试 mock
 * 掉的 fs）时降级为词法路径。
 *
 * 性能说明：仅在工作区内外判定与路径比较处调用（每工具调用每路径一次），同步 realpath 的开销
 * 可接受；不存在的路径会向上找最近的存在祖先，最多一次目录树深度。
 *
 * 另：backend/core/fileWriteLockManager 的锁 key 归一化（resolveLockPath）已复用本函数
 * 对解析出的绝对路径做 realpath 归一，让同一物理文件（经符号链接）的不同写法映射到同一锁 key。
 */
export function resolveRealpathForComparison(fsPath: string): string {
    const absolute = path.resolve(fsPath);
    // realpathSync 可能被测试 mock 掉（jest.mock('fs') 只保留部分 API），缺失时降级词法路径
    const realpathSync = typeof (fs as any).realpathSync?.native === 'function'
        ? (fs as any).realpathSync.native
        : undefined;
    if (!realpathSync) {
        return absolute;
    }

    let current = absolute;
    const tail: string[] = [];
    while (true) {
        try {
            const real = realpathSync(current) as string;
            // tail 经 unshift 构建：unshift 把后失败（更浅）的段放数组前，故 tail 已是
            // 「浅→深」的正确拼接顺序（如 ['workspace','project','src','index.ts']）。
            // 注意：不能再 reverse()——那会拼出 D:\index.ts\src\project\workspace 的错乱路径。
            const combined = tail.length === 0 ? real : path.join(real, ...tail);
            return stripWindowsLongPathPrefix(combined);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            // 只有“路径不存在”才向上找最近的已存在祖先；无权限（EACCES）、符号链接循环
            // （ELOOP）等其他失败直接降级词法路径，避免把不可解析路径误判为真实路径。
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                return absolute;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return absolute;
            }
            tail.unshift(path.basename(current));
            current = parent;
        }
    }
}

/**
 * 去掉 Windows realpath 输出可能带上的长路径前缀（\\?\ 与 \\?\UNC\）。
 *
 * fs.realpathSync.native 在 Windows 长路径/UNC 下会返回 \\?\ 前缀路径，直接参与字符串前缀
 * 比较会让同一物理文件出现两种写法（//?/C:/... 与 C:/...），必须统一为普通盘符/UNC 路径形式。
 * POSIX 路径不含该前缀，调用无副作用。
 */
function stripWindowsLongPathPrefix(p: string): string {
    if (p.startsWith('\\\\?\\UNC\\')) {
        return '\\\\' + p.slice(8);
    }
    if (p.startsWith('\\\\?\\')) {
        return p.slice(4);
    }
    return p;
}

export function normalizePathForComparison(fsPath: string): string {
    let normalized = resolveRealpathForComparison(fsPath).replace(/\\/g, '/');
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, '');
    }
    return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
    const child = normalizePathForComparison(childPath);
    const parent = normalizePathForComparison(parentPath);
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * 查找绝对路径所属的工作区。
 */
export function findWorkspaceForAbsolutePath(absolutePath: string): WorkspaceInfo | undefined {
    const workspaces = getAllWorkspaces();
    return workspaces.find(workspace => isPathInsideOrEqual(absolutePath, workspace.fsPath));
}

/**
 * 判断绝对路径是否位于任意工作区内。
 */
export function isAbsolutePathInWorkspace(absolutePath: string): boolean {
    return findWorkspaceForAbsolutePath(absolutePath) !== undefined;
}

/**
 * 解析文件工具路径。
 *
 * - 相对路径：沿用原有工作区解析逻辑
 * - 绝对路径 / file:// URI：返回对应本地文件 URI，并标记是否位于工作区内
 */
export function resolveFileToolPathWithInfo(pathStr: string): {
    uri: vscode.Uri | undefined;
    workspace: WorkspaceInfo | undefined;
    relativePath: string;
    isExplicit: boolean;
    isOutsideWorkspace: boolean;
    isAbsoluteInput: boolean;
    displayPath: string;
    error?: string;
} {
    if (isAbsoluteFilePathLike(pathStr)) {
        try {
            const uri = toFileUri(pathStr);
            const workspace = findWorkspaceForAbsolutePath(uri.fsPath);
            let relativePath = uri.fsPath;
            if (workspace) {
                relativePath = path.relative(workspace.fsPath, uri.fsPath).replace(/\\/g, '/');
                if (!relativePath) {
                    relativePath = '.';
                }
            }

            return {
                uri,
                workspace,
                relativePath,
                isExplicit: true,
                isOutsideWorkspace: !workspace,
                isAbsoluteInput: true,
                displayPath: uri.fsPath
            };
        } catch (error) {
            return {
                uri: undefined,
                workspace: undefined,
                relativePath: pathStr,
                isExplicit: false,
                isOutsideWorkspace: true,
                isAbsoluteInput: true,
                displayPath: pathStr,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    const resolved = resolveUriWithInfo(pathStr);
    const isOutsideWorkspace = !!(
        resolved.uri &&
        resolved.workspace &&
        !isPathInsideOrEqual(resolved.uri.fsPath, resolved.workspace.fsPath)
    );

    return {
        ...resolved,
        workspace: isOutsideWorkspace ? undefined : resolved.workspace,
        relativePath: isOutsideWorkspace && resolved.uri ? resolved.uri.fsPath : resolved.relativePath,
        isOutsideWorkspace,
        isAbsoluteInput: false,
        displayPath: resolved.uri?.fsPath || pathStr
    };
}

/**
 * 解析相对路径为绝对 URI（支持多工作区）
 *
 * @param relativePath 相对路径（可带工作区前缀）
 * @returns URI，如果无法解析则返回 undefined
 */
export function resolveUri(relativePath: string): vscode.Uri | undefined {
    // 绝对路径直接创建 URI，避免和 workspace 路径错误拼接
    if (isAbsoluteFilePathLike(relativePath)) {
        try {
            return toFileUri(relativePath);
        } catch {
            return undefined;
        }
    }

    const { workspace, relativePath: actualPath } = parseWorkspacePath(relativePath);
    if (!workspace) {
        return undefined;
    }
    return vscode.Uri.joinPath(workspace.uri, actualPath);
}

/**
 * 解析相对路径为绝对 URI，并返回详细信息
 *
 * @param relativePath 相对路径（可带工作区前缀）
 * @returns 解析结果
 */
export function resolveUriWithInfo(relativePath: string): {
    uri: vscode.Uri | undefined;
    workspace: WorkspaceInfo | undefined;
    relativePath: string;
    isExplicit: boolean;
    error?: string;
} {
    // 绝对路径：直接创建 URI，然后检查是否位于某个工作区内
    if (isAbsoluteFilePathLike(relativePath)) {
        try {
            const uri = toFileUri(relativePath);
            const workspace = findWorkspaceForAbsolutePath(uri.fsPath);
            let relPath = uri.fsPath;
            if (workspace) {
                relPath = path.relative(workspace.fsPath, uri.fsPath).replace(/\\/g, '/');
                if (!relPath) {
                    relPath = '.';
                }
            }
            return {
                uri,
                workspace,
                relativePath: relPath,
                isExplicit: true
            };
        } catch (error) {
            return {
                uri: undefined,
                workspace: undefined,
                relativePath: relativePath,
                isExplicit: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    const { workspace, relativePath: actualPath, isExplicit, error } = parseWorkspacePath(relativePath);
    if (!workspace) {
        return { uri: undefined, workspace: undefined, relativePath: actualPath, isExplicit, error };
    }
    return {
        uri: vscode.Uri.joinPath(workspace.uri, actualPath),
        workspace,
        relativePath: actualPath,
        isExplicit
    };
}

/**
 * 将绝对路径转换为相对路径（支持多工作区）
 *
 * @param absolutePath 绝对路径或 URI
 * @param includeWorkspacePrefix 是否包含工作区前缀（多工作区时）
 * @returns 相对路径，如果不在任何工作区内则返回原路径
 */
export function toRelativePath(absolutePath: string | vscode.Uri, includeWorkspacePrefix: boolean = false): string {
    const fsPath = typeof absolutePath === 'string' ? absolutePath : absolutePath.fsPath;
    const workspaces = getAllWorkspaces();
    
    // 查找包含此路径的工作区
    for (const workspace of workspaces) {
        if (isPathInsideOrEqual(fsPath, workspace.fsPath)) {
            let relativePath = path.relative(workspace.fsPath, fsPath);
            // 统一使用正斜杠
            relativePath = relativePath.replace(/\\/g, '/');
            
            // 如果有多个工作区且需要前缀
            if (includeWorkspacePrefix && workspaces.length > 1) {
                return `${workspace.name}/${relativePath}`;
            }
            return relativePath;
        }
    }
    
    // 不在任何工作区内，返回原路径
    return fsPath;
}

/**
 * 检查路径是否在工作区内
 *
 * @param pathStr 路径
 * @returns 是否在工作区内
 */
export function isInWorkspace(pathStr: string): boolean {
    const { workspace } = parseWorkspacePath(pathStr);
    return workspace !== undefined;
}

/**
 * 获取多工作区描述（用于提示词）
 */
export function getWorkspacesDescription(): string {
    const workspaces = getAllWorkspaces();
    
    if (workspaces.length === 0) {
        return t('workspace.noWorkspaceOpen');
    }
    
    if (workspaces.length === 1) {
        return t('workspace.singleWorkspace', { path: workspaces[0].fsPath });
    }
    
    const lines = [t('workspace.multiRootMode')];
    for (const ws of workspaces) {
        lines.push(`- ${ws.name}: ${ws.fsPath}`);
    }
    lines.push('');
    lines.push(t('workspace.useWorkspaceFormat'));
    
    return lines.join('\n');
}
