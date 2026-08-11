/**
 * 流式 Chunk 处理器 —— autoSummary 家族（autoSummaryStatus / autoSummary）
 *
 * 拆分自 streamChunkHandlers.ts（模块化重构第 4 批，纯移动、逻辑不改）。
 */

import type { Content, StreamChunk } from '../../../types'
import type { ChatStoreState } from '../types'
import { contentToMessageEnhanced } from '../parsers'
import { syncTotalMessagesFromWindow, syncFoldedHistoryHint, trimWindowFromTop } from '../windowUtils'
import { getMessageIndexById, insertMessageAt, bumpMessagesStructuralVersion } from '../state'

/**
 * 处理 autoSummaryStatus 类型
 */
export function handleAutoSummaryStatus(
  chunk: StreamChunk,
  state: ChatStoreState
): void {
  if (!chunk.autoSummaryStatus || !chunk.status) {
    return
  }

  if (chunk.status === 'started') {
    state.autoSummaryStatus.value = {
      isSummarizing: true,
      mode: 'auto',
      message: chunk.message
    }
    return
  }

  // completed / failed 都结束提示
  state.autoSummaryStatus.value = null
}


/**
 * 处理 autoSummary 类型
 *
 * 逻辑截断语义：后端不删除任何消息，只给被总结区间 [insertIndex - removedCount, insertIndex)
 * 的消息打 isSummarized 标记，并把总结消息插入到 insertIndex（= summarizeEndIndex）。
 * removedCount = 本次标记的消息数；前端同步：标记窗口内对应消息、插入总结消息、
 * 后续消息 backendIndex +1、totalMessages +1。
 */
export function handleAutoSummary(
  chunk: StreamChunk,
  state: ChatStoreState
): void {
  if (!chunk.summaryContent || typeof chunk.insertIndex !== 'number') {
    return
  }

  const summaryContent = chunk.summaryContent
  // M1：与 parsers 对齐——summaryContent 缺 parts 字段时按空数组容错，
  // 避免 contentToMessageEnhanced 抛 TypeError 中断流式处理
  const normalizedSummaryContent: Content = {
    ...summaryContent,
    parts: Array.isArray(summaryContent.parts) ? summaryContent.parts : []
  }
  const insertIndex = chunk.insertIndex
  // 逻辑截断语义：后端已标记 [insertIndex - removedCount, insertIndex) 区间的消息（不删除）
  const markedCount = typeof chunk.removedCount === 'number' && chunk.removedCount > 0
    ? chunk.removedCount
    : 0

  // 去重：优先用后端稳定消息 id（Content.id）；无 id（旧后端）时回退到
  // “窗口内是否已有 backendIndex === insertIndex 的 isSummary 消息”。
  const summaryContentId = typeof summaryContent.id === 'string' && summaryContent.id.length > 0
    ? summaryContent.id
    : undefined
  const exists = summaryContentId
    ? getMessageIndexById(state, summaryContentId) !== -1
    : state.allMessages.value.some(
        m => m.isSummary && typeof m.backendIndex === 'number' && m.backendIndex === insertIndex
      )
  if (exists) {
    return
  }

  // 如果插入位置在当前窗口之前，仅维护索引偏移即可（总结消息在窗口外不插入）
  if (insertIndex < state.windowStartIndex.value) {
    state.windowStartIndex.value += 1
    for (const msg of state.allMessages.value) {
      if (typeof msg.backendIndex === 'number') {
        msg.backendIndex += 1
      }
    }
    // 原地改写全部 backendIndex（本分支不经过 insertMessageAt，无自动 bump）同样属于
    // 结构变更：todoSnapshot 增量重放依赖的 backendIndex 锚点会整体偏移，必须递增结构
    // 版本强制回退全量重放，否则锚点永久 off-by-one。
    bumpMessagesStructuralVersion(state)
    syncTotalMessagesFromWindow(state)
    // 窗口前插入会顶掉一条可见消息：同步折叠提示，否则 foldedMessageCount 虚高
    syncFoldedHistoryHint(state)
    trimWindowFromTop(state)
    state.autoSummaryStatus.value = null
    return
  }

  // 单遍循环（标记区间与后移区间互斥，可安全合并）：
  // ① 标记被总结覆盖的本地消息（backendIndex ∈ [insertIndex - markedCount, insertIndex)），
  //    原文保留在列表中，仅打标记（UI 以横线分隔已总结/未总结区域）。
  //    下界钳制：markedCount 大于 insertIndex 时（如窗口起始即被总结覆盖）负的 markStart
  //    会让 `b >= markStart` 对全部消息恒真，误标记窗口之外的消息。
  // ② 将当前窗口中插入点及之后的 backendIndex 后移 1。
  const markStart = Math.max(0, insertIndex - markedCount)
  for (const msg of state.allMessages.value) {
    const b = msg.backendIndex
    if (typeof b !== 'number') continue
    if (markedCount > 0 && b >= markStart && b < insertIndex) {
      msg.isSummarized = true
    }
    if (b >= insertIndex) {
      msg.backendIndex = b + 1
    }
  }

  const summaryMessage = contentToMessageEnhanced(normalizedSummaryContent)
  summaryMessage.backendIndex = insertIndex
  summaryMessage.timestamp = summaryContent.timestamp || Date.now()
  summaryMessage.localOnly = false
  summaryMessage.streaming = false

  const localInsertIndex = Math.min(
    Math.max(insertIndex - state.windowStartIndex.value, 0),
    state.allMessages.value.length
  )

  insertMessageAt(state, localInsertIndex, summaryMessage)

  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)
  state.autoSummaryStatus.value = null
}
