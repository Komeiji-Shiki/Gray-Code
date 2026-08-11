/**
 * 上下文总结流程（从 messageActions.ts 拆出）。
 *
 * 包含 summarizeContext / cancelSummarizeRequest / restoreSummarizedMessages。
 * 逻辑逐字迁移：对话级隔离（快照回写）、归属校验等已修 bug 注释原样保留，一行未改。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { Content } from '../../../types'
import type { ChatStoreState } from '../types'
import { sendToExtension } from '../../../utils/vscode'
import { MESSAGES_PAGE_SIZE } from '../conversationActions'
import { contentToMessageEnhanced } from '../parsers'
import { rebuildMessageIndexById } from '../state'
import { safeSetError, resolveConversationModelOverride } from './sendMessageFlow'

// ============ 上下文总结（L-2：从 checkpointActions 迁入，职责归位） ============

/**
 * 总结上下文
 *
 * 将旧的对话历史压缩为一条总结消息
 * 所有参数（keepRecentRounds、summarizePrompt）从后端配置读取
 *
 * @returns 总结结果
 */
export async function summarizeContext(
  state: ChatStoreState,
  loadHistory: () => Promise<void>
): Promise<{
  success: boolean
  summarizedMessageCount?: number
  errorCode?: string
  error?: string
}> {
  const originConversationId = state.currentConversationId.value

  const setManualSummaryStatusForConversation = (
    status: { isSummarizing: boolean; mode?: 'auto' | 'manual'; message?: string } | null
  ) => {
    // 当前仍是原对话，直接更新当前状态
    if (!originConversationId || originConversationId === state.currentConversationId.value) {
      state.autoSummaryStatus.value = status
      return
    }

    // 对话已切换，更新原对话对应标签页快照，避免跨对话污染
    const tab = state.openTabs.value.find(t => t.conversationId === originConversationId)
    if (!tab) return

    const snapshot = state.sessionSnapshots.value.get(tab.id)
    if (snapshot) {
      snapshot.autoSummaryStatus = status ? { ...status } : null
    }
  }

  if (!originConversationId) {
    return { success: false, errorCode: 'NO_CONVERSATION', error: 'No conversation selected' }
  }

  if (!state.configId.value) {
    return { success: false, errorCode: 'NO_CONFIG', error: 'No config selected' }
  }

  // 显示底部提示（对话级隔离）
  setManualSummaryStatusForConversation({
    isSummarizing: true,
    mode: 'manual'
  })

  try {
    // 只传递必要参数，所有配置项从后端读取
    const result = await sendToExtension<{
      success: boolean
      summaryContent?: any
      summarizedMessageCount?: number
      error?: { code: string; message: string }
    }>(MESSAGE_NAMES.summarizeContext, {
      conversationId: originConversationId,
      configId: state.configId.value,
      modelOverride: resolveConversationModelOverride(state)
    })

    if (result.success && result.summaryContent) {
      // 重新加载历史以获取更新后的消息列表
      await loadHistory()

      return {
        success: true,
        summarizedMessageCount: result.summarizedMessageCount
      }
    } else {
      return {
        success: false,
        errorCode: result.error?.code,
        error: result.error?.message || 'Summarize failed'
      }
    }
  } catch (err: any) {
    return {
      success: false,
      errorCode: err?.code,
      error: err.message || 'Summarize failed'
    }
  } finally {
    // 结束提示（对话级隔离）
    setManualSummaryStatusForConversation(null)
  }
}

/**
 * 取消当前对话的总结请求（仅取消总结 API，不影响后续 AI 响应）
 */
export async function cancelSummarizeRequest(state: ChatStoreState): Promise<void> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return

  try {
    await sendToExtension(MESSAGE_NAMES.cancelSummarizeRequest, { conversationId })
  } catch (error) {
    console.error('[messageActions] Failed to cancel summarize request:', error)
  }
}

/**
 * 恢复指定总结消息覆盖的原文（逻辑截断的反向操作）
 *
 * 后端取消覆盖区间的 isSummarized 标记并删除总结消息本身，原文重新参与发送与统计
 * （发送起点回退到上一个总结或 0）。成功后重新加载消息窗口：总结消息消失、原文恢复活跃。
 *
 * @returns 是否成功
 */
export async function restoreSummarizedMessages(
  state: ChatStoreState,
  summaryMessageId: string
): Promise<boolean> {
  const originConvId = state.currentConversationId.value
  if (!originConvId || !summaryMessageId) return false

  try {
    const response = await sendToExtension<{ success: boolean }>(MESSAGE_NAMES.restoreSummarizedMessages, {
      conversationId: originConvId,
      summaryMessageId
    })

    // 校验归属：await 期间当前会话可能已切换
    if (state.currentConversationId.value !== originConvId) return false
    if (!response?.success) return false

    // 重新加载最后一页，确保 backendIndex 与消息列表不错位（总结消息已删除、原文恢复显示）
    const result = await sendToExtension<{ total: number; messages: Content[] }>(MESSAGE_NAMES['conversation.getMessagesPaged'], {
      conversationId: originConvId,
      limit: MESSAGES_PAGE_SIZE
    })
    if (state.currentConversationId.value !== originConvId) return false

    const page = result?.messages || []
    state.totalMessages.value = result?.total ?? page.length
    state.windowStartIndex.value = page[0]?.index ?? 0
    state.allMessages.value = page.map(content => contentToMessageEnhanced(content))
    rebuildMessageIndexById(state)

    state.isLoadingMoreMessages.value = false
    state.historyFolded.value = false
    state.foldedMessageCount.value = 0
    return true
  } catch (err: any) {
    safeSetError(state, originConvId, {
      code: err.code || 'RESTORE_SUMMARY_ERROR',
      message: err.message || 'Restore summary failed'
    })
    return false
  }
}
