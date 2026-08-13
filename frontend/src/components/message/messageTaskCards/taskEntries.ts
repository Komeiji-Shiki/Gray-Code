/**
 * MessageTaskCards 拆分：工具调用 → 任务卡条目（TaskEntry / TaskCardItem）的纯提取逻辑。
 *
 * 原实现内联在主组件里，此处按「文档数据提取 + 状态映射」边界整体搬出，函数体与
 * 原组件逐字保持一致（含 as any 的兼容写法），保证运行时行为不变。
 */
import type { ToolUsage } from '@/types'
import { isDesignDocPath, isPlanDocPath } from '@/utils/taskCards'
import {
  getPlanExecutionPrompt,
  getPlanGenerationPrompt,
  getPlanUpdateMode
} from '@/utils/toolContinuations'
import {
  extractReviewCardData,
  formatReviewToolFallbackContent,
  isReviewToolName
} from '@/utils/reviewCards'
import {
  extractProgressCardData,
  formatProgressToolFallbackContent,
  isProgressToolName
} from '@/utils/progressCards'
import type { CardStatus, TaskCardItem, TaskCardKind, TaskEntry } from './taskCardTypes'

export type ToolResponseById = (toolCallId: string) => unknown

export function getToolResult(tool: ToolUsage, getToolResponseById: ToolResponseById): unknown {
  const fromTool = tool.result && typeof tool.result === 'object'
    ? tool.result
    : undefined

  const fromResponse = tool.id
    ? getToolResponseById(tool.id)
    : undefined

  // 优先融合 functionResponse（包含 reload 后的真实结果、以及后续确认字段）
  if (fromTool && fromResponse && typeof fromResponse === 'object') {
    return { ...(fromTool as Record<string, unknown>), ...(fromResponse as Record<string, unknown>) }
  }
  if (fromResponse && typeof fromResponse === 'object') {
    return fromResponse
  }
  return fromTool
}

export function mapToolStatus(tool: ToolUsage, getToolResponseById: ToolResponseById): CardStatus {
  if (tool.status === 'executing' || tool.status === 'streaming' || tool.status === 'queued') return 'running'
  if (tool.status === 'success') return 'success'
  if (tool.status === 'error') return 'error'

  const r = getToolResult(tool, getToolResponseById)
  if (!r) return 'pending'
  const record = r as Record<string, unknown>
  if (record.success === true) return 'success'
  if (record.success === false) return 'error'
  return 'pending'
}

export function getWriteFileTaskEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  const args = tool.args as any
  // 兼容批量格式 (files 数组) 和单文件格式 (path + content)
  let files = Array.isArray(args?.files) ? args.files : []
  if (files.length === 0) {
    const singlePath = args?.path as string | undefined
    const singleContent = args?.content as string | undefined
    if (singlePath) {
      files = [{ path: singlePath, content: singleContent || '' }]
    }
  }

  const result = getToolResult(tool, getToolResponseById)
  const resultList = Array.isArray((result as any)?.data?.results) ? (result as any).data.results : []
  const successByPath = new Map<string, boolean>()
  for (const r of resultList) {
    if (r?.path && typeof r.path === 'string' && typeof r.success === 'boolean') {
      successByPath.set(r.path, r.success)
    }
  }

  const planExecutionPrompt = getPlanExecutionPrompt(result)
  const planGenerationPrompt = getPlanGenerationPrompt(result)

  const entries: TaskEntry[] = []
  for (const f of files) {
    const path = f?.path
    const content = f?.content
    if (typeof path !== 'string' || typeof content !== 'string') continue

    if (isDesignDocPath(path)) {
      entries.push({
        kind: 'design',
        path,
        content,
        success: successByPath.get(path),
        continuationPrompt: planGenerationPrompt || undefined
      })
      continue
    }

    if (isPlanDocPath(path)) {
      entries.push({
        kind: 'plan',
        path,
        content,
        success: successByPath.get(path),
        continuationPrompt: planExecutionPrompt || undefined
      })
    }
  }

  return entries
}

export function getCreatePlanEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  const args = tool.args as any
  const result = getToolResult(tool, getToolResponseById)

  const path = ((result as any)?.data?.path || args?.path) as string | undefined
  const content = ((result as any)?.data?.content || args?.plan) as string | undefined

  if (typeof path !== 'string' || typeof content !== 'string') return []
  if (!isPlanDocPath(path)) return []

  const success = typeof (result as any)?.success === 'boolean' ? (result as any).success : undefined
  const continuationPrompt = getPlanExecutionPrompt(result) || undefined

  return [{
    kind: 'plan',
    path,
    content,
    success,
    continuationPrompt
  }]
}

export function getUpdatePlanEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  const args = tool.args as any
  const result = getToolResult(tool, getToolResponseById)
  const updateMode = getPlanUpdateMode(result, args)

  const path = ((result as any)?.data?.path || args?.path) as string | undefined
  const content = ((result as any)?.data?.content || args?.plan) as string | undefined

  if (typeof path !== 'string' || typeof content !== 'string') return []
  if (!isPlanDocPath(path)) return []
  if (updateMode === 'progress_sync') return []

  const success = typeof (result as any)?.success === 'boolean' ? (result as any).success : undefined
  const continuationPrompt = getPlanExecutionPrompt(result) || undefined

  return [{
    kind: 'plan',
    path,
    content,
    success,
    continuationPrompt,
    updateMode
  }]
}

export function getCreateDesignEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  const args = tool.args as any
  const result = getToolResult(tool, getToolResponseById)

  const path = ((result as any)?.data?.path || args?.path) as string | undefined
  const content = ((result as any)?.data?.content || args?.design) as string | undefined

  if (typeof path !== 'string' || typeof content !== 'string') return []
  if (!isDesignDocPath(path)) return []

  const success = typeof (result as any)?.success === 'boolean' ? (result as any).success : undefined
  const continuationPrompt = getPlanGenerationPrompt(result) || undefined

  return [{
    kind: 'design',
    path,
    content,
    success,
    continuationPrompt
  }]
}

export function getUpdateDesignEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  const args = tool.args as any
  const result = getToolResult(tool, getToolResponseById)

  const path = ((result as any)?.data?.path || args?.path) as string | undefined
  const content = ((result as any)?.data?.content || args?.design) as string | undefined

  if (typeof path !== 'string' || typeof content !== 'string') return []
  if (!isDesignDocPath(path)) return []

  const success = typeof (result as any)?.success === 'boolean' ? (result as any).success : undefined
  const continuationPrompt = getPlanGenerationPrompt(result) || undefined

  return [{
    kind: 'design',
    path,
    content,
    success,
    continuationPrompt
  }]
}

export function getReviewTaskEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  if (!isReviewToolName(tool.name)) return []

  const args = (tool.args || {}) as Record<string, unknown>
  const result = getToolResult(tool, getToolResponseById)
  if (!result || typeof result !== 'object') return []
  const reviewResult = result as Record<string, unknown>

  const reviewCardData = extractReviewCardData(tool.name, args, reviewResult)
  if (!reviewCardData) return []
  const continuationPrompt = getPlanGenerationPrompt(reviewResult) || undefined

  return [{
    kind: 'review',
    path: reviewCardData.path || '',
    content: formatReviewToolFallbackContent(tool.name, args, reviewResult),
    continuationPrompt,
    success: typeof reviewResult.success === 'boolean' ? reviewResult.success : undefined,
    reviewCardData
  }]
}

export function getProgressTaskEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  if (!isProgressToolName(tool.name)) return []

  const args = (tool.args || {}) as Record<string, unknown>
  const result = getToolResult(tool, getToolResponseById)
  if (!result || typeof result !== 'object') return []
  const progressResult = result as Record<string, unknown>

  const progressCardData = extractProgressCardData(tool.name, args, progressResult)
  const error = typeof progressResult.error === 'string' && progressResult.error.trim()
    ? progressResult.error.trim()
    : undefined
  const warnings = Array.isArray((progressResult as any)?.data?.warnings)
    ? ((progressResult as any).data.warnings as unknown[])
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (!progressCardData) return []

  return [{
    kind: 'progress',
    path: progressCardData.path || '',
    content: formatProgressToolFallbackContent(tool.name, args, progressResult),
    success: typeof progressResult.success === 'boolean' ? progressResult.success : undefined,
    progressCardData,
    error,
    warnings
  }]
}

export function getTaskEntries(tool: ToolUsage, getToolResponseById: ToolResponseById): TaskEntry[] {
  if (tool.name === 'write_file') return getWriteFileTaskEntries(tool, getToolResponseById)
  if (tool.name === 'create_plan') return getCreatePlanEntries(tool, getToolResponseById)
  if (tool.name === 'update_plan') return getUpdatePlanEntries(tool, getToolResponseById)
  if (tool.name === 'create_design') return getCreateDesignEntries(tool, getToolResponseById)
  if (tool.name === 'update_design') return getUpdateDesignEntries(tool, getToolResponseById)
  if (isProgressToolName(tool.name)) return getProgressTaskEntries(tool, getToolResponseById)
  if (isReviewToolName(tool.name)) return getReviewTaskEntries(tool, getToolResponseById)
  return []
}

export function buildTaskCards(
  tools: ToolUsage[],
  getToolResponseById: ToolResponseById,
  getDocumentTitle: (docContent: string, docPath: string, kind: TaskCardKind) => string
): TaskCardItem[] {
  const cards: TaskCardItem[] = []

  for (const tool of tools) {
    const entries = getTaskEntries(tool, getToolResponseById)
    if (entries.length === 0) continue

    for (const entry of entries) {
      const status: CardStatus = entry.continuationPrompt
        ? 'success'
        : typeof entry.success === 'boolean'
          ? (entry.success ? 'success' : 'error')
          : mapToolStatus(tool, getToolResponseById)

      const title = entry.kind === 'review'
        ? (entry.reviewCardData?.title || getDocumentTitle(entry.content, entry.path, entry.kind))
        : entry.kind === 'progress'
          ? (entry.progressCardData?.title || getDocumentTitle(entry.content, entry.path, entry.kind))
          : getDocumentTitle(entry.content, entry.path, entry.kind)

      cards.push({
        key: `${entry.kind}:${tool.id}:${entry.path || title}`,
        kind: entry.kind,
        status,
        title,
        path: entry.path,
        content: entry.content,
        toolId: tool.id,
        toolName: tool.name,
        isActionCompleted: !!entry.continuationPrompt,
        continuationPrompt: entry.continuationPrompt,
        updateMode: entry.updateMode,
        reviewCardData: entry.reviewCardData,
        progressCardData: entry.progressCardData,
        error: entry.error,
        warnings: entry.warnings
      })
    }
  }

  return cards
}
