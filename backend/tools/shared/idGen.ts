/**
 * ID 生成器（从 taskManager / review 的本地实现收敛而来）
 */

/**
 * 生成 prefix_timestamp_random 形式的 ID（十进制时间戳 + 9 位 base36 随机串）。
 * taskManager.generateTaskId 与 terminal/media 的任务 ID 使用。
 */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 生成 review 文档 reviewRunId。
 *
 * 注意：格式为 `review-<base36 时间戳>-<6 位随机串>`（连字符分隔），与
 * generatePrefixedId 的下划线格式不同；reviewRunId 会持久化进 review 文档元数据，
 * 为保证既有文档格式稳定，这里单独保留原 createReviewRunId 的格式与可选 date 参数。
 */
export function generateReviewRunId(date: Date = new Date()): string {
  return `review-${date.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
