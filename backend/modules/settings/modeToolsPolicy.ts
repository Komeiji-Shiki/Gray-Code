/**
 * 模式工具策略
 * 定义不同模式下允许使用的工具和路径规则
 */

/**
 * 检查路径是否允许在指定 GrayCode 文档目录下写入
 *
 * 通用拒绝规则：
 * - 不在指定目录下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 */
function isScopedMarkdownPathAllowed(path: string, scopeRoot: string): boolean {
    // 空字符串不允许
    if (!path || path.length === 0) {
        return false;
    }

    // 处理 Windows 路径分隔符：将 \ 转换为 /
    const normalizedPath = path.replace(/\\/g, '/');

    // 拒绝绝对路径（以 / 开头）
    if (normalizedPath.startsWith('/')) {
        return false;
    }

    // 防止路径穿越：包含 .. 的一律拒绝
    if (normalizedPath.includes('..')) {
        return false;
    }

    // 必须以指定目录开头
    if (!normalizedPath.startsWith(scopeRoot)) {
        return false;
    }

    // 不能只是目录名（以 / 结尾）
    if (normalizedPath.endsWith('/')) {
        return false;
    }

    // 必须是一个文件路径（不能只是目录本身）
    const relativePath = normalizedPath.substring(scopeRoot.length);
    if (!relativePath || relativePath.length === 0) {
        return false;
    }

    // 仅允许 Markdown 文件
    return relativePath.endsWith('.md');
}

/**
 * 检查路径是否允许在 Plan 模式下写入
 * 
 * 允许的路径：
 * - .graycode/plans/xxx.plan.md
 * - .graycode/plans/sub/xxx.md
 * 
 * 拒绝的路径：
 * - 不在 .graycode/plans/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 或 .plan.md 扩展名的文件
 * - 空字符串或目录路径
 * 
 * @param path 要检查的路径
 * @returns 如果路径允许则返回 true，否则返回 false
 */
export function isPlanPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/plans/');
}

/**
 * 检查路径是否允许在 Design 模式下写入
 *
 * 允许的路径：
 * - .graycode/design/xxx.md
 * - .graycode/design/sub/xxx.md
 *
 * 拒绝的路径：
 * - 不在 .graycode/design/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 *
 * @param path 要检查的路径
 * @returns 如果路径允许则返回 true，否则返回 false
 */
export function isDesignPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/design/');
}

/**
 * 检查路径是否允许在 Review 模式下写入
 *
 * 允许的路径：
 * - .graycode/review/xxx.md
 * - .graycode/review/sub/xxx.md
 *
 * 拒绝的路径：
 * - 不在 .graycode/review/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 */
export function isReviewPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/review/');
}

/**
 * 检查路径是否允许在 Progress 能力下写入
 *
 * 首版仅允许固定文件：
 * - .graycode/progress.md
 *
 * 拒绝：
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 空字符串、目录路径或其他 Markdown 文件
 */
export function isProgressPathAllowed(path: string): boolean {
    const normalizedPath = (path || '').replace(/\\/g, '/');
    if (!normalizedPath || normalizedPath.startsWith('/') || normalizedPath.includes('..') || normalizedPath.endsWith('/')) {
        return false;
    }
    return normalizedPath === '.graycode/progress.md';
}

/**
 * 通用文件写工具集合。
 *
 * search_in_files 是读写混合工具：replace 模式等价于通用文件写操作。
 * 若某模式的 toolPolicy allowlist 只授予了 search_in_files 而未授予
 * 任一通用写工具，则 replace 模式构成权限逃逸（只读模式借搜索工具写文件）。
 * 该集合与 tools/subagents/presets.ts 的 WRITE_TOOLS 保持一致，
 * 供模式工具策略与工具执行服务共用判定口径。
 */
export const GENERAL_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
    'write_file',
    'apply_diff',
    'insert_code',
    'delete_code',
    'delete_file',
    'create_directory',
]);

/**
 * 判断模式的 allowlist 是否允许 search_in_files 的 replace 模式。
 *
 * 规则：allowlist 授予了 search_in_files，但未授予任何通用文件写工具时，
 * replace 模式必须被拒绝（防止只读模式借搜索工具修改文件）；search 模式不受影响。
 *
 * @param toolPolicy 模式工具策略 allowlist（undefined/空数组视为未启用过滤，不限制）
 * @returns true 表示 replace 模式被禁止
 */
export function isSearchInFilesReplaceForbidden(toolPolicy: readonly string[] | undefined): boolean {
    if (!toolPolicy || toolPolicy.length === 0) {
        return false;
    }
    if (!toolPolicy.includes('search_in_files')) {
        return false;
    }
    return !toolPolicy.some(name => GENERAL_FILE_WRITE_TOOLS.has(name));
}

/**
 * 获取只读模式下被认为是危险的工具集合
 * 
 * @returns 危险工具名称的 Set
 */
export function getReadonlyModeDangerousTools(): Set<string> {
    return new Set([
        'apply_diff',
        'write_file',
        'delete_file',
        'create_directory',
        'execute_command'
    ]);
}

