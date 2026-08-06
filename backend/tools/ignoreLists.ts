/**
 * 各工具共享的忽略列表。
 *
 * 修改原因：list_files（DEFAULT_IGNORED / RECURSIVE_SKIP_DIRS）与
 * search_in_files（DEFAULT_EXCLUDE）各自维护了一份忽略目录，内容重复且
 * 容易在修改一处后忘记同步另一处。
 * 修改方式：收敛到本模块统一导出，list_files / search_in_files 直接引用。
 * 注意：webview/handlers/FileHandlers.ts 的 DEFAULT_IGNORED 归其他模块维护，
 * 本模块导出名固定为 DEFAULT_IGNORED_DIRS / RECURSIVE_SKIP_DIRS /
 * DEFAULT_EXCLUDE_GLOB，避免与前端文件重名。
 */

/** 默认忽略的目录和文件（list_files 顶层与递归共用的用户可覆盖默认值） */
export const DEFAULT_IGNORED_DIRS: string[] = ['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', '.next', 'coverage'];

/** 递归遍历时额外跳过的常见巨型目录（仅递归下钻时生效，不影响非递归的顶层显式列出） */
export const RECURSIVE_SKIP_DIRS: string[] = ['.git', 'node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.cache'];

/** search_in_files 默认排除 glob */
export const DEFAULT_EXCLUDE_GLOB: string = '**/node_modules/**';
