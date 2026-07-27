/**
 * LimCode - Diff 审阅类工具的统一判定
 *
 * 这些工具的写入都会经过 DiffManager 的 pendingDiff 审阅机制，
 * diff 机制本身就是它们的确认层：
 * - autoSave 关闭：用户在 diff 视图中手动接受/拒绝
 * - autoSave 开启：按配置的延迟自动应用（用户已明确选择自动）
 *
 * 因此这类调用不应再叠加聊天内的工具确认框（双重确认），
 * 确认行为的唯一数据源是 apply_diff 工具设置（autoSave / 延迟 / 跳过差异视图）。
 *
 * 此前的问题：
 * - isManualDiffReviewWriteTool 只覆盖 write_file/apply_diff，
 *   insert_code/delete_code/search_in_files(replace) 在 autoSave 关闭时会被双重确认；
 * - autoSave 开启时 write_file/apply_diff 又要看"自动执行"页的勾选，
 *   用户需要在两个设置页都配置才能真正自动，非常迷糊。
 */

/** 所有参数组合下都走 diff 审阅的工具 */
export const DIFF_REVIEW_TOOL_NAMES = new Set(['apply_diff', 'write_file', 'insert_code', 'delete_code']);

/**
 * 判断一次工具调用是否会进入 diff 审阅流程。
 *
 * search_in_files 仅在 replace 模式下产生 pendingDiff，需要结合参数判断。
 */
export function isDiffReviewToolCall(toolName: string, args?: Record<string, unknown>): boolean {
    if (DIFF_REVIEW_TOOL_NAMES.has(toolName)) {
        return true;
    }

    if (toolName === 'search_in_files') {
        const mode = typeof args?.mode === 'string' ? args.mode : 'search';
        return mode === 'replace';
    }

    return false;
}
