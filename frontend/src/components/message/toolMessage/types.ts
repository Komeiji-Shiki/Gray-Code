import type { PendingDiffSession } from '../diffReviewController'

/**
 * 工具卡内「独立 pending diff 操作栏」使用的视图模型。
 * 从 ToolMessage.vue 抽出（F-07），供 ToolMessage / ToolItem / DiffActionList 共享。
 */
export interface PendingDiffView extends PendingDiffSession {
  progress: number
  timeLeft: number
  isPreparing: boolean
  isProcessing: boolean
  error: string | undefined
}
