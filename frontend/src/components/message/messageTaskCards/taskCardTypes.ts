/**
 * MessageTaskCards 拆分的共享类型与纯函数。
 *
 * 仅承载类型定义与「计划来源状态归一化」这一无副作用纯函数，供主组件、
 * taskEntries 与 usePlanSourceStatus 复用，避免循环依赖。
 */
import type { PlanUpdateMode } from '@/utils/toolContinuations'
import type { ReviewCardData } from '@/utils/reviewCards'
import type { ProgressCardData } from '@/utils/progressCards'

export type CardStatus = 'pending' | 'running' | 'success' | 'error'
export type TaskCardKind = 'design' | 'plan' | 'review' | 'progress'

export type TaskEntry = {
  kind: TaskCardKind
  path: string
  content: string
  success?: boolean
  continuationPrompt?: string
  updateMode?: PlanUpdateMode
  reviewCardData?: ReviewCardData
  progressCardData?: ProgressCardData
  error?: string
  warnings?: string[]
}

export type TaskCardItem = {
  key: string
  kind: TaskCardKind
  status: CardStatus
  title: string
  path: string
  content: string
  toolId: string
  toolName: string
  isActionCompleted: boolean
  continuationPrompt?: string
  updateMode?: PlanUpdateMode
  reviewCardData?: ReviewCardData
  progressCardData?: ProgressCardData
  error?: string
  warnings?: string[]
}

export type PlanSourceStatus = 'up_to_date' | 'mismatched' | 'missing_source' | 'untracked'

export type PlanSourceState = {
  sourceStatus: PlanSourceStatus
  sourceArtifactType?: 'design' | 'review'
  sourcePath?: string
  blocked?: boolean
  error?: string
}

export function normalizePlanSourceState(input: unknown): PlanSourceState {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const sourceStatus = raw.sourceStatus === 'up_to_date'
    || raw.sourceStatus === 'mismatched'
    || raw.sourceStatus === 'missing_source'
    || raw.sourceStatus === 'untracked'
    ? raw.sourceStatus
    : 'untracked'

  return {
    sourceStatus,
    sourceArtifactType: raw.sourceArtifactType === 'design' || raw.sourceArtifactType === 'review' ? raw.sourceArtifactType : undefined,
    sourcePath: typeof raw.sourcePath === 'string' && raw.sourcePath.trim() ? raw.sourcePath : undefined,
    blocked: raw.blocked === true,
    error: typeof raw.error === 'string' && raw.error.trim() ? raw.error : undefined
  }
}
