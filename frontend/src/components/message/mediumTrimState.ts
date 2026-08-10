/**
 * 中展开裁剪提示按 messageId 记忆（模块级）：内容超长被裁是消息内容的属性，不是视图
 * 切换的状态。切到完全展开再切回中展开时 watch 重新注册、CharFlow restore 恢复的尾巴
 * 可能 ≤ 窗口、不再触发 onTrimmed——若无条件重置 mediumTrimmed，提示条会消失而内容
 * 仍被裁过。模块级 Map + 清理函数（与 messageViewModes 同模式）。
 *
 * 从 MessageRenderBlock.vue 的普通 <script> 拆出（S4 批次）：.ts 模块供
 * useVirtualMessageWindow 等纯 TS 文件安全具名导入，避免 .vue 具名导出解析问题。
 */
export const mediumTrimmedByMessageId = new Map<string, boolean>()
export const MEDIUM_TRIMMED_CAP = 500

/**
 * 裁剪提示记录清理（与 MessageList 的 pruneBackgroundTaskViewModes 同口径调用）：
 * 消息删除/窗口裁剪后移除不再渲染的 messageId，避免 Map 只靠容量上限兜底淘汰
 * 仍在渲染的消息记录。
 */
export function pruneMediumTrimmedByMessageId(activeIds: Set<string>): void {
  for (const messageId of Array.from(mediumTrimmedByMessageId.keys())) {
    if (!activeIds.has(messageId)) {
      mediumTrimmedByMessageId.delete(messageId)
    }
  }
}
