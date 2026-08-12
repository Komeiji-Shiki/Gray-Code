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
 * search_in_files 一律返回 null：replace 模式的影响面 = pattern × 目录子树，静态不可知
 *   （args.path 通常是目录，而部分快照对非空目录不递归——被替换的文件不会进入快照，
 *   恢复时既无法还原内容又会被误判）；search 模式只读。两者均回退全量（安全侧）。
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
 * 边界用所选平台的分隔符判断，防止 `/root/outside` 匹配 `/root/outside2`。
 *
 * platform 参数仅供测试注入（默认 process.platform，生产调用不传）——
 * 与 StoragePathManager.isSameStoragePath 同策略：测试显式传 win32 时不能依赖
 * 当前运行平台的语义。注意注入必须同时切换路径解析实现（path.win32/path.posix）：
 * 仅折叠大小写不够——Linux CI 上宿主 path.resolve 不识别反斜杠分隔符与盘符，
 * Windows 路径会被拼到 cwd 下。
 */
export function isPathWithin(
    rootFsPath: string,
    absPath: string,
    platform: NodeJS.Platform = process.platform
): boolean {
    // 按 platform 参数选择路径语义：测试注入 win32/linux 时不能依赖当前运行平台的
    // path 模块（Linux CI 上 path.resolve 是 POSIX 语义，不识别反斜杠分隔符与盘符，
    // 会把 'D:\\GrayCode\\src\\a.ts' 当作普通文件名拼到 cwd 下，与 'd:/graycode'
    // 永不匹配）。生产默认 process.platform 时 path.win32/path.posix 与宿主一致。
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const caseFold = platform === 'win32' || platform === 'darwin'
        ? (p: string) => p.toLowerCase()
        : (p: string) => p;
    const root = caseFold(pathApi.resolve(rootFsPath));
    const target = caseFold(pathApi.resolve(absPath));
    if (target === root) return true;
    return target.startsWith(root + pathApi.sep);
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
            // 先剥离未编码的 fragment/query（file URI 语义中 # 之后是 fragment、? 之后是
            // query，不属于路径；文件名中的字面 #/? 应以 %23/%3F 编码，不受影响），再解码。
            let p = uri.slice('file://'.length).split('#')[0].split('?')[0];
            try {
                // file:///C%3A/Users/... -> /C:/Users/... -> C:/Users/...
                p = decodeURIComponent(p);
            } catch {
                // 非法编码序列（如文件名含未编码 %）：无法可靠确定本地路径 → 回退全量
                return null;
            }
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
    // search_in_files：replace 模式的影响面 = pattern × 目录子树，静态不可知（args.path
    // 通常是目录，部分快照对非空目录不递归，被替换的文件不会进入快照）；search 模式
    // 只读。两者一律回退全量（低频操作，正确性优先）。
    if (toolName === 'search_in_files') {
        return null;
    }
    if (!(toolName in AFFECTED_PATH_FIELDS)) {
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
