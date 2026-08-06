/**
 * VSCode 工具共享辅助函数
 *
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { t } from '../i18n';

// ==================== 文本工具（换行符统一） ====================

const IS_WINDOWS = process.platform === 'win32';

/**
 * 检查文件字节是否为安全的 UTF-8 文本编码。
 *
 * UTF-16（含 BOM）与 GBK 等非 UTF-8 编码被按 UTF-8 解码后会产生乱码，
 * diff 类工具（apply_diff/insert_code/delete_code）读-改-写会把原编码
 * 永久损坏。命中即返回错误描述，由调用方拒绝处理该文件。
 */
export function detectNonUtf8Encoding(buffer: Buffer): string | null {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return null;
    }
    if (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        if ((b0 === 0xFF && b1 === 0xFE) || (b0 === 0xFE && b1 === 0xFF)) {
            return 'file is UTF-16 encoded (unsupported by diff tools)';
        }
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return null;
    } catch {
        return 'file is not valid UTF-8 text (possibly GBK/other legacy encoding)';
    }
}

/**
 * 统一换行符为 LF（\n）。
 *
 * - Windows CRLF (\r\n) -> \n
 * - legacy CR (\r) -> \n
 */
export function normalizeLineEndingsToLF(text: string): string {
    // 单次扫描同时处理 CRLF 与孤立 CR，避免两次全量 replace 各复制一遍字符串
    return text.replace(/\r\n?/g, '\n');
}
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

/**
 * 正则灾难性回溯（ReDoS）粗筛。
 *
 * 检测最常见的危险结构：分组内含量词、且分组后紧跟量词（如 `(a+)+`、
 * `(x+x+)+y`、`(a*)*`、`(a+){2,}`），以及组内含重叠分支且组后跟量词
 * （如 `(a|aa)+`、`(a|ab)+`）、超长模式/超大重复次数、无锚点的贪婪前缀。
 * 命中即拒绝，避免在主线程上对长文本执行指数级回溯。
 */
export function isRegexPotentiallyCatastrophic(pattern: string): boolean {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return false;
    }
    if (pattern.length > 200) {
        return true;
    }
    // 剥离转义序列与字符类后做结构分析
    const stripped = pattern
        .replace(/\\./g, '')
        .replace(/\[[^\]]*\]/g, '');
    // 分组内含量词，且分组后跟量词/限量词：(a+)+、(x+x+)+、(a+){2,}
    if (/(\([^()]*[+*][^()]*\))([+*]|\{[0-9,]+\})/.test(stripped)) {
        return true;
    }
    // 组内含两个以上备选分支（重叠交替）且组后跟量词：(a|aa)+、(a|ab)+、(ab|a)*
    // 交替分支间存在公共前缀时，回溯可能呈指数级增长。
    if (/\([^()]*\|[^()]*\)([+*]|\{[0-9,]+\})/.test(stripped)) {
        return true;
    }
    // 单个非捕获组自身嵌套分组后跟量词：((a)+)+ 由内层规则捕获，外层兜底
    if (/\([^()]*\([^()]*\)[^()]*\)[+*{]/.test(stripped)) {
        return true;
    }
    // 极大的重复次数上限（如 a{1000000}）
    const largeRepeat = stripped.match(/\{[0-9]+,([0-9]+)\}/);
    if (largeRepeat && Number(largeRepeat[1]) > 10000) {
        return true;
    }
    // 贪婪前缀且无锚点：.* 或 (?:.|\n)* 等开头（剥离后形如 .*、(?:.|)*）
    // 会先吞掉尽可能多的输入，失败后再逐字符回退，放大后续分组的回溯代价。
    // 已用 ^ 锚定（剥离不删除 ^）时回退范围受限，风险显著降低，不判高风险。
    if (!/^\^/.test(pattern) && !/\$$/.test(pattern)) {
        const greedyPrefixMatch = stripped.match(/^(\.\*|\([^()]*\.\|[^()]*\)\*)/);
        if (greedyPrefixMatch) {
            return true;
        }
    }
    return false;
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

/**
 * MIME 类型映射（仅限多模态工具调用支持的格式）
 *
 * 支持的类型：
 * - 图片：image/png, image/jpeg, image/webp
 * - 文档：application/pdf, text/plain
 */
const MULTIMODAL_MIME_TYPES: Record<string, string> = {
    // 图片（仅支持这 3 种）
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    // 文档（仅支持 PDF）
    '.pdf': 'application/pdf',
};

/**
 * 支持多模态返回的文件扩展名（图片和 PDF）
 */
const MULTIMODAL_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp',  // 图片
    '.pdf',                              // 文档
]);

/**
 * 多模态工具支持的 MIME 类型
 */
export const MULTIMODAL_SUPPORTED_TYPES = {
    /** 图片类型 */
    images: ['image/png', 'image/jpeg', 'image/webp'],
    /** 文档类型 */
    documents: ['application/pdf', 'text/plain'],
    /** 所有支持的类型 */
    all: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain']
};

/**
 * 所有已知的二进制文件扩展名
 */
const BINARY_EXTENSIONS = new Set([
    // 图片
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.svg', '.ico', '.tiff',
    // 音频
    '.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a', '.wma',
    // 视频
    '.mp4', '.mov', '.avi', '.wmv', '.webm', '.mkv', '.3gp', '.flv', '.m4v',
    // 文档
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // 其他二进制
    '.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

/**
 * 获取文件的 MIME 类型
 */
export function getMultimodalMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return MULTIMODAL_MIME_TYPES[ext] || null;
}

/**
 * 检查是否支持多模态返回
 */
export function isMultimodalSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return MULTIMODAL_EXTENSIONS.has(ext);
}

/**
 * 检查是否是二进制文件
 */
export function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/** 行数统计的文件大小上限：超过后 lineCount 的参考价值很低，不值得付出读取成本 */
const MAX_LINE_COUNT_FILE_SIZE_BYTES = 4 * 1024 * 1024;

/** 分块读取统计行数时的块大小 */
const LINE_COUNT_CHUNK_SIZE = 64 * 1024;

function countLineFeeds(bytes: Uint8Array, length: number): number {
    let newlines = 0;
    for (let i = 0; i < length; i++) {
        if (bytes[i] === 0x0A) {
            newlines++;
        }
    }
    return newlines;
}

export async function countTextFileLines(uri: vscode.Uri, filePath: string): Promise<number | undefined> {
    // 文件发现类工具需要在不读取完整内容到返回值的前提下提示文本文件规模。
    // 二进制文件或读取失败时保持 undefined，避免把该能力变成硬失败。
    //
    // 修改原因：旧实现为了数行数把整个文件读入内存、解码、两次全量 replace
    // 再 split 建数组，且没有大小护栏（大 .log/.csv 会全量进内存）。
    // 修改方式：先用 stat 做大小护栏；本地文件分块读取直接统计 0x0A 字节，
    // 无需解码与字符串分配。行数 = LF 数 + 1，与旧实现 split('\n').length 一致
    //（CRLF 含 LF 仍正确；古老的 CR-only 文件会低估，作为辅助元数据可接受）。
    if (isBinaryFile(filePath)) {
        return undefined;
    }

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number') {
            if (stat.size > MAX_LINE_COUNT_FILE_SIZE_BYTES) {
                return undefined;
            }
            if (stat.size === 0) {
                return 1;
            }
        }

        // 本地文件：分块读取，峰值内存只有一个 64KB 缓冲区
        if (uri.scheme === 'file' && uri.fsPath) {
            const handle = await fsp.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(LINE_COUNT_CHUNK_SIZE);
                let newlines = 0;
                while (true) {
                    const { bytesRead } = await handle.read(buffer, 0, LINE_COUNT_CHUNK_SIZE, null);
                    if (bytesRead <= 0) {
                        break;
                    }
                    newlines += countLineFeeds(buffer, bytesRead);
                }
                return newlines + 1;
            } finally {
                await handle.close();
            }
        }

        // 非 file scheme：无法部分读取，退化为整体读取后按字节统计（已有大小护栏）
        const content = await vscode.workspace.fs.readFile(uri);
        return countLineFeeds(content, content.length) + 1;
    } catch {
        return undefined;
    }
}

/**
 * 带并发上限的 map：按输入顺序返回结果，同时最多 runner 个任务在飞。
 *
 * 修改原因：find_files 对最多 500 个文件用裸 Promise.all 无上限并发读取，
 * list_files 则完全串行；两者都需要一个统一的受控并发工具。
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const runnerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
    const runners = Array.from({ length: runnerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                break;
            }
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 检查文件扩展名是否为图片
 */
export function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
}

/**
 * 检查文件扩展名是否为 PDF
 */
export function isPdfFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.pdf';
}

/**
 * 检查是否支持多模态返回（根据配置）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 是否支持多模态返回
 */
export function isMultimodalSupportedWithConfig(filePath: string, multimodalEnabled: boolean): boolean {
    if (!multimodalEnabled) {
        // 禁用多模态时，不返回任何多模态数据
        return false;
    }
    return isMultimodalSupported(filePath);
}

/**
 * 检查文件是否允许读取（根据多模态配置）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 是否允许读取
 */
export function canReadFile(filePath: string, multimodalEnabled: boolean): boolean {
    // 文本文件总是允许读取
    if (!isBinaryFile(filePath)) {
        return true;
    }
    
    // 二进制文件只有在启用多模态且支持多模态返回时才允许读取
    if (multimodalEnabled && isMultimodalSupported(filePath)) {
        return true;
    }
    
    return false;
}

/**
 * 获取不支持读取的原因
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 错误消息，如果允许读取则返回 null
 */
export function getReadFileError(filePath: string, multimodalEnabled: boolean): string | null {
    if (canReadFile(filePath, multimodalEnabled)) {
        return null;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    
    if (isImageFile(filePath) || isPdfFile(filePath)) {
        return t('multimodal.cannotReadFile', { ext });
    }
    
    return t('multimodal.cannotReadBinaryFile', { ext });
}

// ==================== 渠道类型多模态支持 ====================

/**
 * 渠道类型
 */
export type ChannelType = 'gemini' | 'openai' | 'anthropic' | 'openai-responses';

/**
 * 工具模式
 */
export type ToolMode = 'function_call' | 'xml' | 'json';

/**
 * 多模态能力
 */
export interface MultimodalCapability {
    /** 是否支持图片 */
    supportsImages: boolean;
    /** 是否支持文档（PDF） */
    supportsDocuments: boolean;
    /** 是否支持回传多模态数据到历史记录 */
    supportsHistoryMultimodal: boolean;
}

/**
 * 获取渠道的多模态能力
 * 
 * 根据渠道类型和工具模式，定义不同的多模态支持级别：
 * - gemini: 全面支持所有多模态功能
 * - openai: 
 *   - function_call 模式不支持多模态工具
 *   - xml/json 模式只支持图片，不支持文档
 * - anthropic: 全部支持
 * - custom: 保守处理，假设全部支持
 * 
 * @param channelType 渠道类型
 * @param toolMode 工具模式
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 多模态能力
 */
export function getMultimodalCapability(
    channelType: ChannelType,
    toolMode: ToolMode,
    multimodalEnabled: boolean
): MultimodalCapability {
    // 如果未启用多模态工具，不支持任何多模态功能
    if (!multimodalEnabled) {
        return {
            supportsImages: false,
            supportsDocuments: false,
            supportsHistoryMultimodal: false,
        };
    }
    
    switch (channelType) {
        case 'gemini':
            // Gemini 全面支持
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        case 'openai':
            if (toolMode === 'function_call') {
                // OpenAI function_call 模式：工具响应不能包含图片数据
                // （OpenAI API 要求 tool result 必须是字符串）
                return {
                    supportsImages: false,
                    supportsDocuments: false,
                    supportsHistoryMultimodal: false,
                };
            } else {
                // OpenAI xml/json 模式：
                // - 支持图片（作为 user 消息附件发送）
                // - 不支持文档（PDF）
                // - 历史中的图片可以正常发送（作为 user 消息的 image_url 类型）
                return {
                    supportsImages: true,
                    supportsDocuments: false,
                    supportsHistoryMultimodal: true, // 历史中的图片可以作为 user 消息发送
                };
            }
            
        case 'openai-responses':
            // OpenAI Responses API 全面支持多模态（图片和文档）
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        case 'anthropic':
            // Anthropic 全面支持多模态（图片和文档）
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        default:
            return {
                supportsImages: false,
                supportsDocuments: false,
                supportsHistoryMultimodal: false,
            };
    }
}

/**
 * 根据渠道能力检查文件是否允许读取
 * 
 * @param filePath 文件路径
 * @param capability 多模态能力
 * @returns 是否允许读取
 */
export function canReadFileWithCapability(filePath: string, capability: MultimodalCapability): boolean {
    // 文本文件总是允许读取
    if (!isBinaryFile(filePath)) {
        return true;
    }
    
    // 检查图片支持
    if (isImageFile(filePath)) {
        return capability.supportsImages;
    }
    
    // 检查文档支持（PDF）
    if (isPdfFile(filePath)) {
        return capability.supportsDocuments;
    }
    
    return false;
}

/**
 * 获取不支持读取的详细原因（带渠道能力信息）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @param capability 多模态能力（可选）
 * @returns 错误消息，如果允许读取则返回 null
 */
export function getReadFileErrorWithCapability(
    filePath: string,
    multimodalEnabled: boolean,
    capability?: MultimodalCapability
): string | null {
    // 如果有能力信息，使用能力检查
    if (capability) {
        if (canReadFileWithCapability(filePath, capability)) {
            return null;
        }
    } else {
        if (canReadFile(filePath, multimodalEnabled)) {
            return null;
        }
    }
    
    const ext = path.extname(filePath).toLowerCase();
    
    if (!multimodalEnabled) {
        if (isImageFile(filePath) || isPdfFile(filePath)) {
            return t('multimodal.cannotReadFile', { ext });
        }
    } else if (capability) {
        if (isImageFile(filePath) && !capability.supportsImages) {
            return t('multimodal.cannotReadImage', { ext });
        }
        if (isPdfFile(filePath) && !capability.supportsDocuments) {
            return t('multimodal.cannotReadDocument', { ext });
        }
    }
    
    return t('multimodal.cannotReadBinaryFile', { ext });
}

/**
 * 检查 MIME 类型是否为图片
 */
export function isMimeTypeImage(mimeType: string): boolean {
    return MULTIMODAL_SUPPORTED_TYPES.images.includes(mimeType);
}

/**
 * 检查 MIME 类型是否为文档
 */
export function isMimeTypeDocument(mimeType: string): boolean {
    return MULTIMODAL_SUPPORTED_TYPES.documents.includes(mimeType);
}

// ==================== 图片尺寸计算工具 ====================

/**
 * 图片尺寸信息
 */
export interface ImageDimensions {
    width: number;
    height: number;
    aspectRatio: string;  // 如 "16:9", "4:3", "1:1"
}

/**
 * 计算最大公约数（迭代实现 + 整数化防御，避免浮点输入导致递归不收敛）
 */
export function gcd(a: number, b: number): number {
    let x = Math.abs(Math.trunc(a));
    let y = Math.abs(Math.trunc(b));
    while (y !== 0) {
        const remainder = x % y;
        x = y;
        y = remainder;
    }
    return x;
}

/**
 * 计算宽高比字符串
 *
 * @param width 宽度
 * @param height 高度
 * @returns 宽高比字符串，如 "16:9", "4:3", "1:1"
 */
export function calculateAspectRatio(width: number, height: number): string {
    if (width <= 0 || height <= 0) {
        return '1:1';
    }
    
    const divisor = gcd(width, height);
    const ratioW = width / divisor;
    const ratioH = height / divisor;
    
    // 如果比例数字太大，使用近似值
    if (ratioW > 100 || ratioH > 100) {
        const ratio = width / height;
        // 常见比例检测
        if (Math.abs(ratio - 16/9) < 0.05) return '16:9';
        if (Math.abs(ratio - 9/16) < 0.05) return '9:16';
        if (Math.abs(ratio - 4/3) < 0.05) return '4:3';
        if (Math.abs(ratio - 3/4) < 0.05) return '3:4';
        if (Math.abs(ratio - 3/2) < 0.05) return '3:2';
        if (Math.abs(ratio - 2/3) < 0.05) return '2:3';
        if (Math.abs(ratio - 1) < 0.05) return '1:1';
        if (Math.abs(ratio - 21/9) < 0.05) return '21:9';
        if (Math.abs(ratio - 9/21) < 0.05) return '9:21';
        // 返回小数比例
        return `${ratio.toFixed(2)}:1`;
    }
    
    return `${ratioW}:${ratioH}`;
}

/**
 * 从宽高创建完整的尺寸信息
 */
export function createImageDimensions(width: number, height: number): ImageDimensions {
    return {
        width,
        height,
        aspectRatio: calculateAspectRatio(width, height)
    };
}

/**
 * 转义正则表达式特殊字符。
 */
export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RegexIntentDetection {
    suspected: boolean;
    signals: string[];
}

/**
 * 检测非正则查询里是否包含明显的正则语法。
 *
 * 只返回诊断信号，不自动把字面量搜索改成正则搜索，避免误伤 Markdown 表格、TypeScript union、Shell 管道等普通文本。
 */
export function detectSuspectedRegexIntent(query: string): RegexIntentDetection {
    const signals: string[] = [];

    if (query.includes('.*')) signals.push('.*');
    if (query.includes('.+')) signals.push('.+');
    if (/\\\./.test(query)) signals.push('\\.');
    if (/\\[dDwWsSbB]/.test(query)) signals.push('\\d/\\w/\\s');
    if (/\[[^\]\n]+\]/.test(query)) signals.push('[]');
    if (/\([^()\n]*\|[^()\n]*\)/.test(query)) signals.push('(...) with |');
    if (/\{\d+(,\d*)?\}/.test(query)) signals.push('{n,m}');
    if (query.startsWith('^')) signals.push('^');
    if (query.endsWith('$')) signals.push('$');

    for (let i = 0; i < query.length; i++) {
        if (query[i] !== '|') continue;
        const previous = i > 0 ? query[i - 1] : '';
        const next = i + 1 < query.length ? query[i + 1] : '';
        if (previous && next && !/\s/.test(previous) && !/\s/.test(next)) {
            signals.push('|');
            break;
        }
    }

    return {
        suspected: signals.length > 0,
        signals: Array.from(new Set(signals))
    };
}

export function createSuspectedRegexSuggestion(signals: string[], regexFlagName: string = 'isRegex'): string {
    const signalText = signals.length > 0 ? signals.join(', ') : 'regex-like syntax';
    return `Query contains regex-like syntax (${signalText}), but ${regexFlagName}=false, so these characters were searched literally. Retry with ${regexFlagName}=true if this was intended as regex OR/wildcard/escaped-dot search. The tool does not automatically reinterpret literal queries as regex.`;
}
