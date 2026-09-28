import { isPartialToolData } from '@shared/toolResultStatus'
import { isSubagentInvocationContent } from '@shared/subagentInvocation'
import type { Content, ContentPart, Message, ToolUsage } from '@/types'
import { contentToMessageEnhanced, isOnlyFunctionResponse } from '@/stores/chat/parsers'
import { computePaginatedMessageFloorMap, isNumberedMessage } from '../message/messageListUtils'
import { applyMonitorToolOverlay, type MonitorToolStatusOverlay } from './monitorToolStatusOverlay'
import type { MonitorRunStatus } from './monitorSoundCues'
import type { SubAgentRunContentWindowState } from './monitorWindowState'

export interface MonitorMessageSource {
  runId: string
  status: MonitorRunStatus
  contents: Content[]
  /** 后端模型请求的目标位置；null 表示目前没有模型生成。 */
  streamingContentIndex?: number | null
}

export interface MonitorRenderCacheEntry {
  contentRef: Content
  overlayRef: MonitorToolStatusOverlay | undefined
  responses: Array<ContentPart['functionResponse']>
  message: Message
}

function isToolResponse(content: Content): boolean {
  return content.isFunctionResponse === true || isOnlyFunctionResponse(content)
}

function floorMessage(content: Content, runId: string, index: number) {
  return {
    id: `${runId}_${index}`,
    backendIndex: index,
    // Invocation 是监控配置说明，不是用户发言；持久记录的 role 保持不变。
    role: isSubagentInvocationContent(content) ? 'system' : content.role === 'model' ? 'assistant' : content.role,
    isFunctionResponse: isToolResponse(content)
  }
}

export function computeMonitorMessageFloorMap(window: SubAgentRunContentWindowState | undefined, streamingContentIndex?: number | null): Map<string, number> {
  if (!window) return new Map()
  const messages = window.contents.map((content, offset) => floorMessage(content, window.runId, content.index ?? window.startIndex + offset))
  if (streamingContentIndex === window.totalCount && window.endIndex === window.totalCount) {
    messages.push({ id: `${window.runId}_${streamingContentIndex}`, backendIndex: streamingContentIndex, role: 'assistant', isFunctionResponse: false })
  }
  // 包括不可见工具响应，保持连续索引；旧协议只有从起点加载时才可以自行编号。
  return computePaginatedMessageFloorMap(messages, window.floorIndices ?? null, window.totalCount)
}

/** live delta 只追加于已确认的连续尾窗；本地新楼层在落盘校准前沿用同一全局索引。 */
export function appendMonitorFloorIndices(window: SubAgentRunContentWindowState, contents: Content[]): number[] | undefined {
  if (!window.floorIndices || contents.length === window.contents.length) return window.floorIndices
  const appended = contents.slice(window.contents.length)
  return [...window.floorIndices, ...appended.flatMap((content, offset) => {
    const index = window.totalCount + offset
    return isNumberedMessage(floorMessage(content, window.runId, index)) ? [index] : []
  })]
}

function deriveToolStatus(result: unknown): ToolUsage['status'] {
  const r = result as any
  if (r?.cancelled || r?.rejected) return 'error'
  const data = r?.data
  if (data?.status === 'pending') return 'awaiting_apply'
  if (isPartialToolData(data)) return 'warning'
  if (r?.success === false || r?.error) return 'error'
  return 'success'
}

/** 复用主聊天 MessageItem 的流式正文/Loading，仅把实际运行中的尾部 model 投影为流式态。 */
export function renderMonitorMessages(
  run: MonitorMessageSource,
  window: SubAgentRunContentWindowState | undefined,
  overlay: MonitorToolStatusOverlay | undefined,
  active: boolean,
  cache: Map<number, MonitorRenderCacheEntry>
): Message[] {
  const responseMap = new Map<string, NonNullable<ContentPart['functionResponse']>>()
  for (const content of run.contents) {
    for (const part of content.parts) {
      if (part.functionResponse?.id) responseMap.set(part.functionResponse.id, part.functionResponse)
    }
  }
  const streaming = active && run.status === 'running' && typeof run.streamingContentIndex === 'number' && window?.hasMoreAfter === false
  const tailIndex = (window?.totalCount ?? 0) - 1
  const messages: Message[] = []
  for (let offset = 0; offset < run.contents.length; offset++) {
    const content = run.contents[offset]
    if (isToolResponse(content)) continue
    const index = content.index ?? (window?.startIndex ?? 0) + offset
    const shouldStream = streaming && content.role === 'model' && index === tailIndex && index === run.streamingContentIndex
    const cached = cache.get(index)
    const responses = content.parts.filter(part => part.functionCall).map(part => part.functionCall!.id ? responseMap.get(part.functionCall!.id) : undefined)
    if (cached && cached.contentRef === content && cached.overlayRef === overlay
      && responses.every((response, i) => response === cached.responses[i])) {
      const message = cached.message.streaming === shouldStream ? cached.message : { ...cached.message, streaming: shouldStream }
      if (message !== cached.message) cache.set(index, { ...cached, message })
      messages.push(message)
      continue
    }
    const message = contentToMessageEnhanced(content, `${run.runId}_${index}`)
    message.backendIndex = index
    message.streaming = shouldStream
    if (message.tools?.length) {
      message.tools = message.tools.map(tool => {
        const projected = applyMonitorToolOverlay(tool, overlay)
        const response = responseMap.get(tool.id)
        return response ? { ...projected, result: response.response as Record<string, unknown>, status: deriveToolStatus(response.response) } : projected
      })
    }
    cache.set(index, { contentRef: content, overlayRef: overlay, responses, message })
    messages.push(message)
  }
  if (streaming && run.streamingContentIndex === window?.totalCount && window.endIndex === window.totalCount) {
    // 使用与首个 delta 相同的楼层身份，但不伪造已持久化 backendIndex/时间或消息操作。
    messages.push({ id: `${run.runId}_${run.streamingContentIndex}`, role: 'assistant', content: '', parts: [], timestamp: 0, streaming: true })
  }
  return messages
}
