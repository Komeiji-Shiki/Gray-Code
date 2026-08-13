/**
 * ResponseViewerDialog 拆分的共享格式化 / 标签映射纯函数。
 *
 * 原实现内联在主组件里，此处按「格式化 + 标签映射 + 信息条目构建」边界整体搬出。
 * t() 为 i18n 模块级响应式函数，在模板/computed 调用时仍会建立语言依赖，行为与原
 * 组件内联调用完全一致。
 */
import { t } from '@/i18n'
import { formatTime } from '@/utils/format'
import { formatTokenRate, shouldShowStreamDuration } from '@/utils/tokenRate'
import type {
  ResponseViewerData,
  ResponseViewerPartPreview,
  ResponseViewerResolvedFunctionResponse,
  ResponseViewerToolPreview
} from '../responseViewer/buildResponseViewerData'

export interface ViewerInfoItem {
  label: string
  value: string
}

export function formatInteger(value: number): string {
  return value.toLocaleString()
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatBytes(size: number): string {
  if (!size) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatBoolean(value: boolean): string {
  return value ? t('components.message.responseViewer.yes') : t('components.message.responseViewer.no')
}

export function formatJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const MAX_STRING = 12_000

  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === 'bigint') {
        return currentValue.toString()
      }

      if (typeof currentValue === 'string' && currentValue.length > MAX_STRING) {
        return `${currentValue.slice(0, MAX_STRING)}\n... (truncated, total=${currentValue.length})`
      }

      if (currentValue && typeof currentValue === 'object') {
        if (seen.has(currentValue)) {
          return '[Circular]'
        }
        seen.add(currentValue)
      }

      return currentValue
    }, 2)
  } catch {
    try {
      return String(value)
    } catch {
      return '[Unserializable]'
    }
  }
}

export function formatJsonInline(value: unknown): string {
  const text = formatJson(value).replace(/\s+/g, ' ').trim()
  if (text.length <= 240) {
    return text
  }
  return `${text.slice(0, 240)}...`
}

export function formatStructuredValue(value: unknown): string {
  return typeof value === 'string' ? value : formatJson(value)
}

export function getCollapsedText(text?: string): string {
  return text || t('components.message.responseViewer.empty')
}

export function getRoleLabel(role: string): string {
  if (role === 'user') return t('components.message.roles.user')
  if (role === 'tool') return t('components.message.roles.tool')
  return t('components.message.roles.assistant')
}

export function getPartTypeLabel(type: ResponseViewerPartPreview['type']): string {
  switch (type) {
    case 'text':
      return t('components.message.responseViewer.partTypes.text')
    case 'thought':
      return t('components.message.responseViewer.partTypes.thought')
    case 'functionCall':
      return t('components.message.responseViewer.partTypes.functionCall')
    case 'functionResponse':
      return t('components.message.responseViewer.partTypes.functionResponse')
    case 'inlineData':
      return t('components.message.responseViewer.partTypes.inlineData')
    case 'fileData':
      return t('components.message.responseViewer.partTypes.fileData')
    default:
      return t('components.message.responseViewer.partTypes.unknown')
  }
}

export function getToolStatusLabel(status?: ResponseViewerToolPreview['status']): string {
  switch (status) {
    case 'streaming':
      return t('components.message.responseViewer.toolStatuses.streaming')
    case 'queued':
      return t('components.message.responseViewer.toolStatuses.queued')
    case 'awaiting_approval':
      return t('components.message.responseViewer.toolStatuses.awaitingApproval')
    case 'executing':
      return t('components.message.responseViewer.toolStatuses.executing')
    case 'awaiting_apply':
      return t('components.message.responseViewer.toolStatuses.awaitingApply')
    case 'success':
      return t('components.message.responseViewer.toolStatuses.success')
    case 'error':
      return t('components.message.responseViewer.toolStatuses.error')
    case 'warning':
      return t('components.message.responseViewer.toolStatuses.warning')
    default:
      return t('components.message.responseViewer.toolStatuses.unknown')
  }
}

export function getToolStatusClass(status?: ResponseViewerToolPreview['status']): string {
  return status ? `status-${status}` : 'status-unknown'
}

export function getReviewCardStatus(status?: ResponseViewerToolPreview['status']): 'pending' | 'running' | 'success' | 'error' {
  switch (status) {
    case 'streaming':
    case 'queued':
    case 'awaiting_approval':
    case 'executing':
    case 'awaiting_apply':
      return 'running'
    case 'error':
      return 'error'
    case 'success':
    case 'warning':
      return 'success'
    default:
      return 'pending'
  }
}

export function getResultSourceLabel(
  source?: ResponseViewerToolPreview['resultSource'] | ResponseViewerResolvedFunctionResponse['source']
): string {
  switch (source) {
    case 'tool':
      return t('components.message.responseViewer.responseSources.tool')
    case 'partFunctionResponse':
      return t('components.message.responseViewer.responseSources.partFunctionResponse')
    case 'hiddenFunctionResponse':
      return t('components.message.responseViewer.responseSources.hiddenFunctionResponse')
    default:
      return t('components.message.responseViewer.empty')
  }
}

export function formatSourceMessage(messageId?: string, backendIndex?: number): string {
  const parts: string[] = []

  if (messageId) {
    parts.push(messageId)
  }

  if (typeof backendIndex === 'number') {
    parts.push(`#${formatInteger(backendIndex)}`)
  }

  return parts.join(' · ')
}

export function getToolArgsValue(tool: ResponseViewerToolPreview): unknown {
  return tool.partialArgs && tool.status === 'streaming'
    ? tool.partialArgs
    : tool.args
}

export function getPartFunctionCallArgs(part: ResponseViewerPartPreview): unknown {
  if (!part.functionCall) {
    return {}
  }

  return part.functionCall.partialArgs || part.functionCall.args || {}
}

export function buildResponseInfoItems(data: ResponseViewerData): ViewerInfoItem[] {
  const items: ViewerInfoItem[] = []
  const usage = data.common.usage
  const timing = data.common.timing

  if (data.basic.modelVersion) {
    items.push({
      label: t('components.message.responseViewer.modelVersion'),
      value: data.basic.modelVersion
    })
  }

  if (typeof usage?.totalTokenCount === 'number' && usage.totalTokenCount > 0) {
    items.push({
      label: t('components.message.responseViewer.totalTokens'),
      value: formatInteger(usage.totalTokenCount)
    })
  }

  if (typeof usage?.promptTokenCount === 'number' && usage.promptTokenCount > 0) {
    items.push({
      label: t('components.message.responseViewer.promptTokens'),
      value: formatInteger(usage.promptTokenCount)
    })
  }

  if (typeof usage?.candidatesTokenCount === 'number' && usage.candidatesTokenCount > 0) {
    items.push({
      label: t('components.message.responseViewer.outputTokens'),
      value: formatInteger(usage.candidatesTokenCount)
    })
  }

  if (typeof usage?.thoughtsTokenCount === 'number' && usage.thoughtsTokenCount > 0) {
    items.push({
      label: t('components.message.responseViewer.thoughtTokens'),
      value: formatInteger(usage.thoughtsTokenCount)
    })
  }

  if (typeof timing.thinkingDuration === 'number' && timing.thinkingDuration > 0) {
    items.push({
      label: t('components.message.responseViewer.thinkingDuration'),
      value: formatDuration(timing.thinkingDuration)
    })
  }

  if (typeof timing.responseDuration === 'number' && timing.responseDuration > 0) {
    items.push({
      label: t('components.message.responseViewer.responseDuration'),
      value: formatDuration(timing.responseDuration)
    })
  }

  // 修改原因：新记录中 streamDuration 与 responseDuration 同源，详情页并列展示两个近似相同值会造成噪音。
  // 修改方式：通过公共判断函数在容差内隐藏重复 streamDuration，差异较大的旧记录仍展示。
  // 修改目的：让修复后的详情页保持简洁，同时保留异常或历史数据的诊断信息。
  if (shouldShowStreamDuration(timing.responseDuration, timing.streamDuration)) {
    items.push({
      label: t('components.message.responseViewer.streamDuration'),
      value: formatDuration(timing.streamDuration!)
    })
  }

  if (typeof timing.chunkCount === 'number' && timing.chunkCount > 0) {
    items.push({
      label: t('components.message.responseViewer.chunkCount'),
      value: formatInteger(timing.chunkCount)
    })
  }

  if (typeof timing.tokenRate === 'number' && timing.tokenRate > 0) {
    items.push({
      label: t('components.message.responseViewer.tokenRate'),
      // 修改原因：详情页与消息列表需要一致的小数位，不能继续各自手写 toFixed。
      // 修改方式：复用公共格式化函数，单位仍由当前 UI 拼接。
      // 修改目的：保持展示口径统一，同时不把文案耦合进工具函数。
      value: `${formatTokenRate(timing.tokenRate)} t/s`
    })
  }

  return items
}

export function buildBasicInfoItems(data: ResponseViewerData): ViewerInfoItem[] {
  const items: ViewerInfoItem[] = [
    {
      label: t('components.message.responseViewer.id'),
      value: data.basic.id
    },
    {
      label: t('components.message.responseViewer.role'),
      value: getRoleLabel(data.basic.role)
    }
  ]

  if (typeof data.basic.timestamp === 'number' && data.basic.timestamp > 0) {
    items.push({
      label: t('components.message.responseViewer.timestamp'),
      value: formatTime(data.basic.timestamp)
    })
  }

  if (typeof data.basic.backendIndex === 'number') {
    items.push({
      label: t('components.message.responseViewer.backendIndex'),
      value: formatInteger(data.basic.backendIndex)
    })
  }

  if (data.basic.modelVersion) {
    items.push({
      label: t('components.message.responseViewer.modelVersion'),
      value: data.basic.modelVersion
    })
  }

  if (data.basic.isFunctionResponse) {
    items.push({
      label: t('components.message.responseViewer.flags'),
      value: t('components.message.responseViewer.functionResponseMessage')
    })
  }

  if (data.basic.isSummary) {
    items.push({
      label: t('components.message.responseViewer.flags'),
      value: t('components.message.responseViewer.summaryMessage')
    })
  }

  return items
}

export function buildMetadataKnownItems(data: ResponseViewerData): ViewerInfoItem[] {
  const items: ViewerInfoItem[] = []
  const metadata = data.advanced.metadata
  const usage = data.common.usage

  if (metadata?.model) {
    items.push({
      label: t('components.message.responseViewer.model'),
      value: metadata.model
    })
  }

  if (typeof metadata?.tokens === 'number' && metadata.tokens > 0) {
    items.push({
      label: t('components.message.responseViewer.legacyTotalTokens'),
      value: formatInteger(metadata.tokens)
    })
  }

  if (typeof metadata?.latency === 'number' && metadata.latency > 0) {
    items.push({
      label: t('components.message.responseViewer.latency'),
      value: formatDuration(metadata.latency)
    })
  }

  if (typeof metadata?.firstChunkTime === 'number' && metadata.firstChunkTime > 0) {
    items.push({
      label: t('components.message.responseViewer.firstChunkTime'),
      value: formatTime(metadata.firstChunkTime)
    })
  }

  if (usage?.promptTokensDetails?.length) {
    items.push({
      label: t('components.message.responseViewer.promptTokenDetails'),
      value: formatJsonInline(usage.promptTokensDetails)
    })
  }

  if (usage?.candidatesTokensDetails?.length) {
    items.push({
      label: t('components.message.responseViewer.outputTokenDetails'),
      value: formatJsonInline(usage.candidatesTokensDetails)
    })
  }

  return items
}

export function buildMetadataExtra(data: ResponseViewerData): Record<string, unknown> | null {
  const metadata = data.advanced.metadata
  if (!metadata) {
    return null
  }

  const {
    modelVersion: _modelVersion,
    model: _model,
    usageMetadata: _usageMetadata,
    thinkingStartTime: _thinkingStartTime,
    thinkingDuration: _thinkingDuration,
    responseDuration: _responseDuration,
    firstChunkTime: _firstChunkTime,
    streamDuration: _streamDuration,
    chunkCount: _chunkCount,
    thoughtsTokenCount: _thoughtsTokenCount,
    candidatesTokenCount: _candidatesTokenCount,
    tokens: _tokens,
    latency: _latency,
    ...rest
  } = metadata

  return Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : null
}
