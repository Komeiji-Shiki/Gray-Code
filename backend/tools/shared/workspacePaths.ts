// 从 utils.ts 拆分而来（多工作区路径解析）

import * as vscode from 'vscode';
import * as path from 'path';
import * as fsSync from 'fs';
import { t } from '../../i18n';
import { IS_WINDOWS } from './textUtils';

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
 * 按 URI 查找工作区。
 *
 * 多工作区语义：对话绑定工作区必须独立于“当前打开的工作区”——桌面版切换打开
 * 工作区后，绑定工作区会从 workspaceFolders 移除，但对话仍需在该工作区内解析
 * 工具路径、执行命令与读写文件。因此 URI 未命中已打开文件夹时，若目录仍存在，
 * 则按 URI 重建“虚拟工作区”（index = -1 表示不在当前窗口打开）继续解析。
 */
export function getWorkspaceByUri(workspaceUri: string): WorkspaceInfo | undefined {
    const workspaces = getAllWorkspaces();
    const open = workspaces.find(w => {
        // 防御性访问 toString（测试替身的 Uri 可能没有该方法），真实宿主必有
        const uriString = typeof (w.uri as any)?.toString === 'function' ? (w.uri as any).toString() : undefined;
        return uriString === workspaceUri;
    });
    if (open) return open;

    if (!workspaceUri) return undefined;
    try {
        const uri = workspaceUri.startsWith('file://')
            ? vscode.Uri.parse(workspaceUri)
            : vscode.Uri.file(workspaceUri);
        if (uri.scheme !== 'file' || !uri.fsPath) return undefined;
        const fsPath = uri.fsPath;
        try {
            if (!fsSync.existsSync(fsPath) || !fsSync.statSync(fsPath).isDirectory()) {
                return undefined;
            }
        } catch {
            return undefined;
        }
        return { name: path.basename(fsPath) || fsPath, uri, fsPath, index: -1 };
    } catch {
        return undefined;
    }
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
 * 工作区根下是否存在与工作区同名的真实目录（zip/7z 解压嵌套，如 proj/proj/...）。
 *
 * 存在时路径首段（与工作区同名）是真实目录而非工作区名前缀，parseWorkspacePath
 * 不得剥离该前缀；不存在时首段才按「工作区名 + 路径」格式解释。Windows/macOS
 * 文件系统大小写不敏感，statSync 直接命中；Linux 上内层目录大小写通常与
 * 工作区名一致（解压保留原名），精确匹配即可覆盖实际场景。
 */
function hasSameNameNestedDir(workspace: WorkspaceInfo): boolean {
    try {
        return fsSync.statSync(path.join(workspace.fsPath, workspace.name)).isDirectory();
    } catch {
        return false;
    }
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
 * @param preferredWorkspaceUri 首选工作区 URI（可选）。仅在多工作区且未显式指定前缀时
 *        作为兜底使用；显式前缀始终优先。
 * @returns 解析结果，包含工作区信息和相对路径
 */
export function parseWorkspacePath(pathStr: string, preferredWorkspaceUri?: string): {
    workspace: WorkspaceInfo | undefined;
    relativePath: string;
    isExplicit: boolean;  // 是否显式指定了工作区
    error?: string;       // 错误信息
} {
    const workspaces = getAllWorkspaces();

    // 对话绑定工作区（可能已关闭，getWorkspaceByUri 会按 URI 重建虚拟工作区）：
    // 绑定工作区优先于当前打开文件夹，保证对话工作区独立——桌面版切换打开工作区
    // 后，绑定工作区的相对路径仍解析到原工作区而不是新打开的工作区。
    const boundWorkspace = preferredWorkspaceUri ? getWorkspaceByUri(preferredWorkspaceUri) : undefined;

    // 绑定工作区前缀剥离：路径以绑定工作区名开头时视为其相对路径。
    // 注意：zip/7z 解压会在工作区根下产生与工作区同名的真实目录（proj/proj/... 双层嵌套），
    // 此时首段「与工作区同名」是真实目录而非工作区名前缀——无脑剥离会把文件树索引里
    // 显示的 proj/README.md 解析到根下的 README.md（错位一层），read/write/list 全部 ENOENT。
    // 因此仅当工作区根下不存在同名目录时才剥离；存在时按原样解析（与索引展示一致），
    // 多层重名（proj/proj/proj/...）同理只判定首段。
    if (boundWorkspace) {
        const boundPrefix = boundWorkspace.name + '/';
        const maybeNested = pathStr === boundWorkspace.name || pathStr.startsWith(boundPrefix);
        const hasNestedSameName = maybeNested ? hasSameNameNestedDir(boundWorkspace) : false;
        if (pathStr.startsWith(boundPrefix) && !hasNestedSameName) {
            return { workspace: boundWorkspace, relativePath: pathStr.substring(boundPrefix.length), isExplicit: true };
        }
        if (pathStr === boundWorkspace.name && !hasNestedSameName) {
            return { workspace: boundWorkspace, relativePath: '.', isExplicit: true };
        }
        if (hasNestedSameName) {
            // 同名嵌套目录存在：路径首段是真实目录，按原样解析（含多层重名）
            return { workspace: boundWorkspace, relativePath: pathStr, isExplicit: true };
        }
    }

    // 如果没有工作区：绑定工作区（虚拟）仍可解析
    if (workspaces.length === 0) {
        if (boundWorkspace) {
            return { workspace: boundWorkspace, relativePath: pathStr, isExplicit: false };
        }
        return { workspace: undefined, relativePath: pathStr, isExplicit: false, error: 'No workspace folder open' };
    }

    // 如果只有一个工作区，直接返回
    if (workspaces.length === 1) {
        // 绑定工作区与打开工作区不同（已关闭）时：对话工作区独立，解析到绑定工作区
        if (boundWorkspace) {
            return { workspace: boundWorkspace, relativePath: pathStr, isExplicit: false };
        }
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
    
    // 多工作区时未指定前缀：优先使用首选工作区（按 URI 匹配，含已关闭的绑定工作区）兜底
    if (boundWorkspace) {
        return { workspace: boundWorkspace, relativePath: pathStr, isExplicit: false };
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

export function normalizePathForComparison(fsPath: string): string {
    let normalized = path.resolve(fsPath).replace(/\\/g, '/');
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

/** realpath 结果缓存（同一批工具调用内重复解析同一路径很常见）。
 *
 * 安全加固：缓存必须按“最近存在祖先”的 mtime 失效——
 * 若解析后有人在祖先目录里新建了符号链接（如 mklink），旧缓存会把新链接路径
 * 仍判定为祖先的普通子路径，导致 containment 检查绕过。命中缓存时重新 stat 祖先，
 * mtime 变化即重新解析。
 */
const realPathCache = new Map<string, { resolved: string; ancestorMtimeMs: number }>();
const REAL_PATH_CACHE_MAX = 512;

/**
 * 解析路径的真实位置；对不存在的路径，向上回溯到最近存在的祖先后拼接剩余段。
 *
 * 这使 containment 判定具备符号链接/目录联接感知能力：
 * 工作区内指向外部的 symlink/junction 会被识别为“实际在工作区外”，
 * 杜绝词法前缀比较被链接逃逸绕过。
 */
function resolveRealPathOrNearestExisting(filePath: string): string | null {
    const cached = realPathCache.get(filePath);
    if (cached !== undefined) {
        // 命中缓存后校验祖先 mtime：目录内新增/移除条目（如新建符号链接）会更新目录 mtime，
        // 此时缓存结果可能已失效，需要重新解析。
        if (cached.resolved !== '') {
            try {
                const ancestor = nearestExistingAncestorOf(filePath);
                if (ancestor !== null) {
                    const stat = fsSync.statSync(ancestor, { throwIfNoEntry: false });
                    if (stat && stat.mtimeMs === cached.ancestorMtimeMs) {
                        return cached.resolved;
                    }
                    // mtime 变化：删除缓存走重新解析
                    realPathCache.delete(filePath);
                } else {
                    return cached.resolved;
                }
            } catch {
                // stat 失败（权限等）：保守起见重新解析
                realPathCache.delete(filePath);
            }
        } else {
            return cached.resolved;
        }
    }

    let result: string | null = null;
    const trailing: string[] = [];
    let current = filePath;

    while (true) {
        try {
            result = fsSync.realpathSync.native?.(current) ?? fsSync.realpathSync(current);
            break;
        } catch {
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            trailing.unshift(path.basename(current));
            current = parent;
        }
    }

    if (result !== null && trailing.length > 0) {
        result = path.join(result, ...trailing);
    }

    // 记录最近存在祖先的 mtime，用于缓存失效判断
    let ancestorMtimeMs = 0;
    try {
        const ancestor = nearestExistingAncestorOf(filePath);
        if (ancestor !== null) {
            const stat = fsSync.statSync(ancestor, { throwIfNoEntry: false });
            ancestorMtimeMs = stat?.mtimeMs ?? 0;
        }
    } catch {
        ancestorMtimeMs = 0;
    }

    if (realPathCache.size >= REAL_PATH_CACHE_MAX) {
        realPathCache.clear();
    }
    realPathCache.set(filePath, { resolved: result ?? '', ancestorMtimeMs });
    return result;
}

/**
 * 找到路径的“最近存在祖先”（不含自身解析失败的情况）：与解析逻辑同一套回溯，
 * 供缓存失效判断使用。路径自身存在时返回自身。
 */
function nearestExistingAncestorOf(filePath: string): string | null {
    let current = filePath;
    while (true) {
        if (fsSync.existsSync(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

/**
 * 符号链接感知的“路径位于目录内或相等”判断。
 *
 * 词法判定通过后，再用 realpath 对双方做真实位置比较：
 * 只有真实位置仍位于真实工作区内才算数。
 */
export function isPathInsideOrEqualReal(childPath: string, parentPath: string): boolean {
    const lexical = isPathInsideOrEqual(childPath, parentPath);
    if (!lexical) {
        // 词法已判定在外：若真实位置仍在外，结论不变；realpath 只会让结果更严格，
        // 但工作区根自身可能是符号链接（如 macOS /tmp），需用真实位置复核。
        const realChild = resolveRealPathOrNearestExisting(childPath);
        const realParent = resolveRealPathOrNearestExisting(parentPath);
        if (realChild && realParent) {
            return isPathInsideOrEqual(realChild, realParent);
        }
        return false;
    }
    const realChild = resolveRealPathOrNearestExisting(childPath);
    const realParent = resolveRealPathOrNearestExisting(parentPath);
    if (realChild && realParent) {
        return isPathInsideOrEqual(realChild, realParent);
    }
    return lexical;
}

/**
 * 查找绝对路径所属的工作区。
 *
 * @param preferredWorkspaceUri 对话绑定工作区 URI：绝对路径未命中已打开工作区、
 *        但位于绑定工作区（可能已关闭）内时归属该工作区
 */
export function findWorkspaceForAbsolutePath(absolutePath: string, preferredWorkspaceUri?: string): WorkspaceInfo | undefined {
    const workspaces = getAllWorkspaces();
    const open = workspaces.find(workspace => isPathInsideOrEqualReal(absolutePath, workspace.fsPath));
    if (open) return open;
    if (preferredWorkspaceUri) {
        const bound = getWorkspaceByUri(preferredWorkspaceUri);
        if (bound && isPathInsideOrEqualReal(absolutePath, bound.fsPath)) {
            return bound;
        }
    }
    return undefined;
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
 *
 * @param pathStr 路径字符串
 * @param preferredWorkspaceUri 首选工作区 URI（可选，多工作区无前缀时的兜底）
 */
export function resolveFileToolPathWithInfo(pathStr: string, preferredWorkspaceUri?: string): {
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
            const workspace = findWorkspaceForAbsolutePath(uri.fsPath, preferredWorkspaceUri);
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

    const resolved = resolveUriWithInfo(pathStr, preferredWorkspaceUri);
    const isOutsideWorkspace = !!(
        resolved.uri &&
        resolved.workspace &&
        !isPathInsideOrEqualReal(resolved.uri.fsPath, resolved.workspace.fsPath)
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
 * @param preferredWorkspaceUri 首选工作区 URI（可选，多工作区无前缀时的兜底）
 * @returns URI，如果无法解析则返回 undefined
 */
export function resolveUri(relativePath: string, preferredWorkspaceUri?: string): vscode.Uri | undefined {
    // 绝对路径直接创建 URI，避免和 workspace 路径错误拼接
    if (isAbsoluteFilePathLike(relativePath)) {
        try {
            return toFileUri(relativePath);
        } catch {
            return undefined;
        }
    }

    const { workspace, relativePath: actualPath } = parseWorkspacePath(relativePath, preferredWorkspaceUri);
    if (!workspace) {
        return undefined;
    }
    return vscode.Uri.joinPath(workspace.uri, actualPath);
}

/**
 * 解析相对路径为绝对 URI，并返回详细信息
 *
 * @param relativePath 相对路径（可带工作区前缀）
 * @param preferredWorkspaceUri 首选工作区 URI（可选，多工作区无前缀时的兜底）
 * @returns 解析结果
 */
export function resolveUriWithInfo(relativePath: string, preferredWorkspaceUri?: string): {
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
            const workspace = findWorkspaceForAbsolutePath(uri.fsPath, preferredWorkspaceUri);
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

    const { workspace, relativePath: actualPath, isExplicit, error } = parseWorkspacePath(relativePath, preferredWorkspaceUri);
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
