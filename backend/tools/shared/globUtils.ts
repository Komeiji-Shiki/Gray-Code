/**
 * glob 排除模式工具（发现 11）。
 *
 * find_files 与 searchPass 曾各自实现一份几乎相同的
 * 「配置排除模式 → 单模式/大括号组合 → 默认排除 node_modules」逻辑，
 * 仅设置的来源（getFindFilesConfig vs getSearchInFilesConfig）不同。
 * 统一收敛到这里，两个调用方传入各自配置。
 */

/** 未配置排除模式时的默认值 */
export const DEFAULT_EXCLUDE_PATTERN = '**/node_modules/**';

/**
 * 把配置的排除模式列表合并为单个 glob 模式：
 * - 未配置/空列表 → fallback（默认排除 node_modules，见 DEFAULT_EXCLUDE_PATTERN）；
 * - 单条 → 原样返回；
 * - 多条 → 用大括号语法组合（{a,b,c}）。
 */
export function buildExcludePattern(
    excludePatterns: readonly string[] | undefined,
    fallback: string = DEFAULT_EXCLUDE_PATTERN
): string {
    if (excludePatterns && excludePatterns.length > 0) {
        // 多个模式用 {} 语法组合
        if (excludePatterns.length === 1) {
            return excludePatterns[0];
        }
        return `{${excludePatterns.join(',')}}`;
    }
    return fallback;
}
