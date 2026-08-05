/**
 * Chat Store 计算属性
 */

import { computed } from 'vue'
import type { ChatStoreState, ChatStoreComputed } from './types'
import {
  getToolApprovalStopKind,
  isAwaitingToolUserConfirmation
} from '../../utils/toolContinuations'
import { getVisibleChatMessagesCached } from './windowUtils'

/**
 * 创建 Chat Store 计算属性
 */
export function createChatComputed(state: ChatStoreState): ChatStoreComputed {
  /** 当前对话 */
  const currentConversation = computed(() => 
    state.conversations.value.find(c => c.id === state.currentConversationId.value) || null
  )
  
  /** 排序后的对话列表（按更新时间降序） */
  const sortedConversations = computed(() =>
    [...state.conversations.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )
  
  /** 按工作区筛选后的对话列表 */
  const filteredConversations = computed(() => {
    if (state.workspaceFilter.value === 'all' || !state.currentWorkspaceUri.value) {
      return sortedConversations.value
    }
    // 筛选当前工作区的对话
    return sortedConversations.value.filter(c => {
      if (c.workspaceUri === state.currentWorkspaceUri.value) return true
      return !!c.integrityStatus && c.integrityStatus !== 'ok'
    })
  })
  
  /**
   * 用于显示的消息列表（过滤掉纯 functionResponse 消息）
   *
   * HIS-12：使用增量可见消息缓存——流式期间每个 chunk 只更新尾元素，
   * 不再对全窗口（≤800 条）重复 filter 扫描；结构性变更自动回退全量重建。
   */
  const messages = computed(() =>
    getVisibleChatMessagesCached(state)
  )
  
  /** 是否有消息 */
  const hasMessages = computed(() => state.allMessages.value.length > 0)
  
  /** 是否显示空状态 */
  const showEmptyState = computed(() => state.allMessages.value.length === 0 && !state.isLoading.value)
  
  /** 当前模型名称（用于显示） */
  const currentModelName = computed(() => state.selectedModelId.value || state.currentConfig.value?.model || state.configId.value)
  
  /** 最大上下文 Tokens（从配置获取） */
  const maxContextTokens = computed(() => state.currentConfig.value?.maxContextTokens || 256000)
  
  /** 当前使用的 Tokens（从最后一条助手消息获取） */
  const usedTokens = computed(() => {
    let latestSummaryEstimate: { timestamp: number; tokens: number } | undefined
    for (const msg of state.allMessages.value) {
      const estimated = msg.summaryTokenStats?.estimatedContextTokenCountAfter
      if (msg.isSummary && typeof estimated === 'number') {
        if (!latestSummaryEstimate || msg.timestamp >= latestSummaryEstimate.timestamp) {
          latestSummaryEstimate = { timestamp: msg.timestamp, tokens: estimated }
        }
      }
    }
    // 从后往前找最后一条助手消息
    for (let i = state.allMessages.value.length - 1; i >= 0; i--) {
      const msg = state.allMessages.value[i]
      if (msg.role === 'assistant' && msg.metadata?.usageMetadata) {
        // 总结消息会插入到被压缩范围的末尾，数组位置早于保留消息；用 timestamp 判断
        // 它是否发生在这条旧 usage 之后。下一次真实主回复到达后自然恢复使用真实值。
        if (latestSummaryEstimate && latestSummaryEstimate.timestamp >= msg.timestamp) {
          return latestSummaryEstimate.tokens
        }
        return msg.metadata.usageMetadata.totalTokenCount || 0
      }
    }
    return 0
  })
  
  /**
   * 检测是否需要显示"继续对话"按钮
   *
   * 当最后一条消息是 functionResponse（工具执行结果），
   * 且不在流式响应状态、没有错误、没有正在重试时，
   * 说明对话被中断，需要显示继续按钮
   *
   * 例外：如果工具返回了 requiresUserConfirmation（如 create_plan / create_design），
   * 说明工具主动要求暂停循环等待用户操作（如点击"执行计划"或"生成计划"），
   * 此时不应显示此提示。
   * 但若该工具已写入 continuation prompt（如 planExecutionPrompt / planGenerationPrompt），则恢复显示"继续"提示。
   */
  const needsContinueButton = computed(() => {
    if (state.allMessages.value.length === 0) return false
    if (state.isStreaming.value || state.isWaitingForResponse.value) return false
    if (state.error.value) return false  // 有错误时显示错误面板，不显示继续按钮
    if (state.retryStatus.value?.isRetrying) return false  // 正在重试
    
    const lastMessage = state.allMessages.value[state.allMessages.value.length - 1]
    if (!lastMessage.isFunctionResponse) return false

    // 检查是否有工具要求暂停等待用户确认（如 create_plan / create_design）
    // 此时卡片会显示对应操作按钮，不需要额外的"继续"提示
    const hasPendingUserConfirmation = lastMessage.parts?.some(p => {
      const toolName = p.functionResponse?.name
      const response = p.functionResponse?.response as any
      return isAwaitingToolUserConfirmation(response)
        || (typeof toolName === 'string' && getToolApprovalStopKind(toolName, response) !== null)
    })

    if (hasPendingUserConfirmation) {
      return false
    }


    return true
  })
  
  /** Token 使用百分比 */
  const tokenUsagePercent = computed(() => {
    if (maxContextTokens.value === 0) return 0
    return Math.min(100, (usedTokens.value / maxContextTokens.value) * 100)
  })

  /**
   * 检测是否有待确认的工具调用
   *
   * 当 isWaitingForResponse = true 且 isStreaming = false 时，
   * 检查最后一条助手消息中是否有 status = 'pending' 的工具
   */
  const hasPendingToolConfirmation = computed(() => {
    // 必须在等待响应但不在流式状态
    if (!state.isWaitingForResponse.value || state.isStreaming.value) return false

    // 从后往前找最后一条助手消息
    for (let i = state.allMessages.value.length - 1; i >= 0; i--) {
      const msg = state.allMessages.value[i]
      if (msg.role === 'assistant' && msg.tools && msg.tools.length > 0) {
        // 检查是否有 awaiting_approval 状态的工具
        return msg.tools.some(tool => tool.status === 'awaiting_approval')
      }
    }
    return false
  })

  /**
   * 获取待确认的工具列表
   */
  const pendingToolCalls = computed(() => {
    if (!hasPendingToolConfirmation.value) return []

    // 从后往前找最后一条助手消息
    for (let i = state.allMessages.value.length - 1; i >= 0; i--) {
      const msg = state.allMessages.value[i]
      if (msg.role === 'assistant' && msg.tools && msg.tools.length > 0) {
        return msg.tools.filter(tool => tool.status === 'awaiting_approval')
      }
    }
    return []
  })

  return {
    currentConversation,
    sortedConversations,
    filteredConversations,
    messages,
    hasMessages,
    showEmptyState,
    currentModelName,
    maxContextTokens,
    usedTokens,
    tokenUsagePercent,
    needsContinueButton,
    hasPendingToolConfirmation,
    pendingToolCalls
  }
}
