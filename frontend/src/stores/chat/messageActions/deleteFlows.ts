/**
 * 删除流程（从 messageActions.ts 拆出）。
 *
 * 包含 deleteMessage / deleteSingleMessage / clearMessages。逻辑逐字迁移，
 * 越界兜底（本地占位 / 后端索引越界降级本地删除）、H1/M6 平滑条目清理、
 * MESSAGE_CHANGED 索引漂移校验等已修 bug 注释原样保留，一行未改。
 */

import type { Content } from '../../../types'
import type { ChatStoreState } from '../types'
import { sendToExtension } from '../../../utils/vscode'
import { MESSAGES_PAGE_SIZE, loadCheckpoints, refreshCurrentConversationBuildSession } from '../conversationActions'
import { clearCheckpointsFromIndex } from '../checkpointActions'
import { contentToMessageEnhanced } from '../parsers'
import { setTotalMessagesFromWindow } from '../windowUtils'
import { rebuildMessageIndexById } from '../state'
import { finishSmoothStreamForState, clearAllSmoothForState } from '../streamChunkHandlers'
import { translate } from '../../../composables/useI18n'
import { useSettingsStore } from '../../settingsStore'
import { safeSetError, calculateBackendIndex } from './sendMessageFlow'
import { isEmptyAssistantPlaceholder, isLocalOnlyAssistant } from './retryFlows'
import type { CancelStreamCallback } from './sendMessageFlow'

/**
 * 删除消息
 */
export async function deleteMessage(
  state: ChatStoreState,
  targetIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value) return
  if (targetIndex < 0 || targetIndex >= state.allMessages.value.length) return

  // await cancelStream() 之前固化 originConvId、targetMessageId、backendIndex
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[targetIndex]?.id
  const isLocalPlaceholder = isLocalOnlyAssistant(state.allMessages.value[targetIndex]) || isEmptyAssistantPlaceholder(state.allMessages.value[targetIndex])
  const backendIndex = !isLocalPlaceholder
    ? calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)
    : -1
  // 越界兑底：后端索引 >= 后端历史长度（totalMessages）说明该消息在后端并不存在——
  // 典型场景是「前端窗口包含未持久化的尾部占位消息」（localOnly 标记因流式异常/重载而丢失，
  // 或数据文件被外部修改后前后端不一致）。此时走后端删除会命中 INVALID_TARGET_INDEX，
  // 这里降级为本地删除（与 localOnly 占位同一路径）。
  const isBackendIndexOutOfBounds = !isLocalPlaceholder && backendIndex >= (state.totalMessages.value || 0)
  const treatAsLocal = isLocalPlaceholder || isBackendIndexOutOfBounds

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换，目标消息可能已变化
  if (state.currentConversationId.value !== originConvId) return
  if (!treatAsLocal && state.allMessages.value[targetIndex]?.id !== targetMessageId) return

  // 如果删除目标是”本地空占位 assistant / 后端索引越界”（后端并不存在），只做本地删除，避免后端索引越界。
  if (treatAsLocal) {
    const msgId = state.allMessages.value[targetIndex]?.id
    // H1/M6：删除前清理该消息的平滑条目（如流式占位残留），避免 smoothTexts 泄漏
    finishSmoothStreamForState(state, msgId)
    // 重新计算（可能因为 cancel 导致窗口变化）
    const currentBackendFrom = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)
    state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
    rebuildMessageIndexById(state)
    // 截断后旧消息的工具响应缓存失效：清空，防止 id 复用读到已删除轮的响应
    state.toolResponseCache.value = new Map()
    clearCheckpointsFromIndex(state, currentBackendFrom)
    setTotalMessagesFromWindow(state)
    if (state.streamingMessageId.value && msgId && state.streamingMessageId.value === msgId) {
      state.streamingMessageId.value = null
    }
    state.activeStreamId.value = null
    state.isStreaming.value = false
    state.isWaitingForResponse.value = false

    // 本地占位删除后也刷新一次 activeBuild，避免残留旧 Build 壳
    await refreshCurrentConversationBuildSession(state)
    return
  }

  try {
    const response = await sendToExtension<any>('deleteMessage', {
      conversationId: originConvId,
      targetIndex: backendIndex,
      // 索引漂移校验：后端据 messageId 校验目标消息未被其他请求移动
      messageId: targetMessageId
    })

    // 再次校验归属
    if (state.currentConversationId.value !== originConvId) return

    if (response?.success) {
      state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
      rebuildMessageIndexById(state)
      // 截断后旧消息的工具响应缓存失效：清空，防止 id 复用读到已删除轮的响应
      state.toolResponseCache.value = new Map()
      clearCheckpointsFromIndex(state, backendIndex)
      setTotalMessagesFromWindow(state)
      // H1/M6：删除消息后清理其平滑条目（如流式期间删除半截回答），避免 smoothTexts 泄漏
      finishSmoothStreamForState(state, targetMessageId)
      await refreshCurrentConversationBuildSession(state)
    } else {
      const err = response?.error
      safeSetError(state, originConvId, {
        code: err?.code || 'DELETE_ERROR',
        message: err?.code === 'MESSAGE_CHANGED'
          ? translate(useSettingsStore().language || 'zh-CN', 'stores.chatStore.errors.messageChanged')
          : (err?.message || 'Delete failed')
      })
      console.error('[messageActions] deleteMessage failed:', response)
    }
  } catch (err: any) {
    safeSetError(state, originConvId, {
      code: err.code || 'DELETE_ERROR',
      message: err.code === 'MESSAGE_CHANGED'
        ? translate(useSettingsStore().language || 'zh-CN', 'stores.chatStore.errors.messageChanged')
        : (err.message || 'Delete failed')
    })
  }
}

/**
 * 删除单条消息（不删除后续消息）
 */
export async function deleteSingleMessage(
  state: ChatStoreState,
  targetIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value) return

  // await cancelStream() 之前固化 originConvId 与 backendIndex
  const originConvId = state.currentConversationId.value

  // 注意：deleteSingleMessage 会导致后续消息索引整体前移。
  // 因此这里把 targetIndex 视为”后端绝对索引（backendIndex）”，并在成功后重新加载窗口，避免索引错位。
  const backendIndex = targetIndex
  if (backendIndex < 0) return

  // H1/M6：记录将被删除消息的本地 id（按 backendIndex 定位），成功后清理其平滑条目
  const removedMessageId = state.allMessages.value.find(m => m.backendIndex === backendIndex)?.id

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换
  if (state.currentConversationId.value !== originConvId) return

  // 越界兑底：目标索引 >= 后端历史长度时，该消息在后端不存在
  // （前端窗口含未持久化的尾部占位 / 数据被外部修改后前后端不一致），
  // 只做本地移除，避免后端 INVALID_TARGET_INDEX；后续消息索引不受影响（原本就不在后端）。
  if (backendIndex >= (state.totalMessages.value || 0)) {
    state.allMessages.value = state.allMessages.value.filter(m => m.backendIndex !== backendIndex)
    if (removedMessageId) {
      finishSmoothStreamForState(state, removedMessageId)
    }
    setTotalMessagesFromWindow(state)
    rebuildMessageIndexById(state)
    await refreshCurrentConversationBuildSession(state)
    return
  }

  try {
    const response = await sendToExtension<{ success: boolean }>('deleteSingleMessage', {
      conversationId: originConvId,
      targetIndex: backendIndex
    })

    // 再次校验归属
    if (state.currentConversationId.value !== originConvId) return

    if (response.success) {
      // 重新加载最后一页，确保 backendIndex 与 checkpoints 的 messageIndex 不错位
      const result = await sendToExtension<{ total: number; messages: Content[] }>('conversation.getMessagesPaged', {
        conversationId: originConvId,
        limit: MESSAGES_PAGE_SIZE
      })
      // 再次校验归属
      if (state.currentConversationId.value !== originConvId) return

      const page = result?.messages || []
      state.totalMessages.value = result?.total ?? page.length
      state.windowStartIndex.value = page[0]?.index ?? 0
      state.allMessages.value = page.map(content => contentToMessageEnhanced(content))
      rebuildMessageIndexById(state)

      state.isLoadingMoreMessages.value = false
      state.historyFolded.value = false
      state.foldedMessageCount.value = 0

      // H1/M6：删除成功后清理被删消息的平滑条目（如流式期间删除半截回答）
      if (removedMessageId) {
        finishSmoothStreamForState(state, removedMessageId)
      }

      await loadCheckpoints(state)
      await refreshCurrentConversationBuildSession(state)
    }
  } catch (err: any) {
    safeSetError(state, originConvId, {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Delete failed'
    })
  }
}

/**
 * 清空当前对话的消息
 */
export function clearMessages(state: ChatStoreState): void {
  // H1/M6：清空前清理所有平滑条目（销毁实例 + 删除显示文本），UI 立即切回真实 content
  clearAllSmoothForState(state)
  state.allMessages.value = []
  state.windowStartIndex.value = 0
  state.totalMessages.value = 0
  state.isLoadingMoreMessages.value = false
  state.toolResponseCache.value = new Map()
  state.historyFolded.value = false
  state.foldedMessageCount.value = 0
  state.activeBuild.value = null
  state.error.value = null
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state._lastCancelledStreamId.value = null
  state.isWaitingForResponse.value = false
}
