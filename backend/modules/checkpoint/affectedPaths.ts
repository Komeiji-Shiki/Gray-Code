/**
 * 工具执行存档「受影响路径」提取（CP-PARTIAL-1，checkpoint 性能优化）。
 *
 * 背景：工具执行批次前后会创建工作区快照存档（buildWorkspaceSnapshot 递归扫描整个
 * 工作区，对每个文件 stat + 哈希，大工作区可达 10-20MB 哈希表）。实际上工具只改了
 * 参数指定的文件，全量扫描是浪费。这里按「模型传入参数」提取受影响文件的绝对路径，
 * 供快照构建器只对列出的路径 stat + 哈希（部分快照）。
 *
 * 契约：
 * - 返回绝对路径数组（单个工具调用至多一个路径，调用方跨调用聚合去重）；
 * - 返回 null 表示无法确定受影响路径（调用方回退全量扫描，保证快照完整性）。
 *
 * 白名单工具（args 中的 `path` 字段，均为 string）：
 *   write_file / apply_diff / insert_code / delete_code / delete_file / create_directory
 * search_in_files 仅 replace 模式写文件（取 args.path）；search 模式只读 → null。
 * 其余工具（execute_command 等副作用不可知）→ null。
 *
 * 安全边界：
 * - args.path 非字符串或为空 → null；
 * - 相对路径 resolve 到工作区根下；绝对路径原样；
 * - 路径穿越防御：resolve 后必须位于工作区根内（大小写不敏感前缀 + 路径边界，
 *   防止 `/root/outside` 匹配 `/root/outside2`），否则返回 null。
 */
import * as path from 'path';

/** 白名单：工具名 → args 中承载文件路径的字段（均为 string） */
const AFFECTED_PATH_FIELDS: Record<string, string> = {
    write_file: 'path',
    apply_diff: 'path',
    insert_code: 'path',
    delete_code: 'path',
    delete_file: 'path',
    create_directory: 'path'
};

/**
 * 判断绝对路径是否位于工作区根内（含等于根自身）。
 *
 * 大小写策略与 checkpointPathUtils.isExcludedAbsolutePath 同族（EX-CASE-1/EX-CASE-2）：
 * - win32（Windows 文件系统不区分大小写）与 darwin（macOS 默认 APFS 大小写不敏感卷）
 *   下折叠小写比较；
 * - 其余平台（大小写敏感）按原样比较。
 * 边界用 `path.sep` 判断，防止 `/root/outside` 匹配 `/root/outside2`。
 */
export function isPathWithin(rootFsPath: string, absPath: string): boolean {
    const caseFold = process.platform === 'win32' || process.platform === 'darwin'
        ? (p: string) => p.toLowerCase()
        : (p: string) => p;
    const root = caseFold(path.resolve(rootFsPath));
    const target = caseFold(path.resolve(absPath));
    if (target === root) return true;
    return target.startsWith(root + path.sep);
}

/**
 * 把工作区 URI（`file:///...` 或 `file:///C%3A/...` 编码形式）解析为 fsPath。
 *
 * 非 `file://` 形态（vscode-remote:// 等）无法确定本地文件系统路径 → 返回 null，
 * 调用方回退全量扫描（安全侧）。解析失败同样返回 null。
 */
export function workspaceUriToFsPath(uri: string): string | null {
    if (!uri || typeof uri !== 'string') return null;
    try {
        let fsPath = uri;
        if (uri.startsWith('file://')) {
            // file:///C%3A/Users/... -> /C:/Users/... -> C:/Users/...
            let p = decodeURIComponent(uri.slice('file://'.length));
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
            fsPath = p.replace(/\//g, path.sep);
        } else {
            // 非 file://（vscode-remote 等）：无法确定本地 fs 路径
            return null;
        }
        if (!fsPath) return null;
        return path.resolve(fsPath);
    } catch {
        return null;
    }
}

/**
 * 从单个工具调用参数中提取受影响文件的绝对路径。
 *
 * @param toolName 工具名（write_file / apply_diff / ...）
 * @param args 工具调用参数（模型传入）
 * @param workspaceRootFsPath 工作区根 fsPath（相对路径 resolve 的基准）
 * @returns 绝对路径数组（至多一个元素）；null = 无法确定受影响路径（回退全量）
 */
export function extractAffectedPaths(
    toolName: string,
    args: unknown,
    workspaceRootFsPath: string
): string[] | null {
    // search_in_files：仅 replace 模式写文件（取 args.path）；search 模式只读 → 无法确定
    if (toolName === 'search_in_files') {
        if ((args as { mode?: unknown } | null | undefined)?.mode !== 'replace') {
            return null;
        }
    } else if (!(toolName in AFFECTED_PATH_FIELDS)) {
        // 非白名单工具（execute_command 等副作用不可知）→ 无法确定
        return null;
    }

    const field = AFFECTED_PATH_FIELDS[toolName] ?? 'path';
    const raw = (args as Record<string, unknown> | null | undefined)?.[field];
    if (typeof raw !== 'string' || raw.length === 0) {
        return null;
    }

    const resolved = path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(workspaceRootFsPath, raw);

    // 路径穿越防御：resolve 后必须位于工作区根内，否则回退全量
    if (!isPathWithin(workspaceRootFsPath, resolved)) {
        return null;
    }

    return [resolved];
}
