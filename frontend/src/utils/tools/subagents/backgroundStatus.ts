/**
 * 后台派发子代理状态推导（单一数据源）
 *
 * 供 ToolMessage 头部与 SubAgentsComponent 卡片共用，避免状态判断分散在两处。
 */

import type { BackgroundTaskRecord } from '../../../stores/backgroundTasks/reportBuilder'

export type BackgroundTaskCardStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * 推导后台派发子代理的工具卡片真实状态。
 *
 * @param taskId - 从 subagent result 中提取的 taskId
 * @param tasks - backgroundTaskStore 中的任务表快照
 * @param subagentResult - subagents 工具的 result（可能为 stub）
 * @returns 推导出的任务卡片状态
 *
 * - 有活跃任务记录 → 按任务状态映射
 * - 无任务记录 → 中性状态：根据 result.success 推导完成/失败，不返回 running
 */
export function computeTaskCardStatus(
  taskId: string | undefined,
  tasks: Record<string, BackgroundTaskRecord | undefined>,
  subagentResult: Record<string, unknown> | undefined
): BackgroundTaskCardStatus {
  // 非后台派发 → 直接按 result.success 判定
  const data = (subagentResult as any)?.data as Record<string, unknown> | undefined
  const isBackground = data?.background === true

  if (!isBackground) {
    const success = (subagentResult as any)?.success === true
    return success ? 'completed' : 'failed'
  }

  // 后台派发 → 以 backgroundTaskStore 为权威数据源
  if (!taskId) {
    // 没有 taskId 的 stub 无法追踪 — 按 stub 中的 success 判定
    const success = (subagentResult as any)?.success === true
    return success ? 'completed' : 'failed'
  }

  const task = tasks[taskId]
  if (!task) {
    // 任务记录已被清除（可能是 Tab 切换/Store 重置）
    // 中性状态：按 stub 中的 success 字段判定
    const success = (subagentResult as any)?.success === true
    return success ? 'completed' : 'failed'
  }

  switch (task.status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'running'
  }
}
