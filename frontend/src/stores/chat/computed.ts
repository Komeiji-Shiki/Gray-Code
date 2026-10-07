/**
 * Chat Store 计算属性
 */

import { computed } from 'vue'
import type { Message } from '../../types'
import type { ChatStoreState, ChatStoreComputed } from './types'
import {
  getToolApprovalStopKind,
  isAwaitingToolUserConfirmation
} from '../../utils/toolContinuations'
import { getVisibleChatMessagesCached } from './windowUtils'
import { getMessagesStructuralVersion } from './state'

/**
 * usedTokens 增量扫描的区间输出（供全量/增量两种路径共用，保证口径完全一致）
 */
interface UsedTokensScanOutput {
  lastAssistantUsage: { timestamp: number; totalTokenCount: number } | undefined
  latestSummaryEstimate: { timestamp: number; tokens: number } | undefined
}

/**
 * 单趟逆序扫描一个区间（原实现为「正序找最新总结估算」+「逆序找最后一条助手消息」两趟，
 * 合并为一趟减少数组访问）：
 * - lastAssistantUsage：区间内最后一条带 usageMetadata 的助手消息
 * - latestSummaryEstimate：区间内全部总结消息中 timestamp 最大的估算（与正序扫描取 max 等价）
 */
function scanUsedTokensRange(
  messages: Message[],
  from: number,
  to: number,
  out: UsedTokensScanOutput
): void {
  for (let i = to - 1; i >= from; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.metadata?.usageMetadata && !out.lastAssistantUsage) {
      out.lastAssistantUsage = {
        timestamp: msg.timestamp,
        totalTokenCount: msg.metadata.usageMetadata.totalTokenCount || 0
      }
    }
    const estimated = msg.summaryTokenStats?.estimatedContextTokenCountAfter
    if (msg.isSummary && typeof estimated === 'number') {
      if (!out.latestSummaryEstimate || msg.timestamp >= out.latestSummaryEstimate.timestamp) {
        out.latestSummaryEstimate = { timestamp: msg.timestamp, tokens: estimated }
      }
    }
  }
}

/**
 * usedTokens 只缓存 [0, scannedCount) 的固定前缀，不包含仍可能改写的尾消息。
 * 数组身份和响应式结构版本不变时，只扫描新进入前缀的消息与当前尾消息。
 */
interface UsedTokensScanCache {
  scannedCount: number
  messagesRef: Message[]
  lastAssistantUsage: { timestamp: number; totalTokenCount: number } | undefined
  latestSummaryEstimate: { timestamp: number; tokens: number } | undefined
  /** 缓存时的消息数组结构版本（state.ts 维护）：非纯尾部 splice/删除/整体替换会递增 */
  version: number
}

/** 助手用量按数组位置取最后一条；总结按时间取最新，并列保留较早的位置。 */
function mergeUsedTokensScan(prefix: UsedTokensScanOutput, suffix: UsedTokensScanOutput): UsedTokensScanOutput {
  const before = prefix.latestSummaryEstimate
  const after = suffix.latestSummaryEstimate
  return {
    lastAssistantUsage: suffix.lastAssistantUsage ?? prefix.lastAssistantUsage,
    latestSummaryEstimate: before && (!after || before.timestamp >= after.timestamp) ? before : after
  }
}

/**
 * 创建 Chat Store 计算属性
 */
export function createChatComputed(state: ChatStoreState): ChatStoreComputed {
  /** usedTokens 增量扫描缓存（见 UsedTokensScanCache 定义）：流式期间每 chunk 只扫尾部 */
  let usedTokensScanCache: UsedTokensScanCache | null = null

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
    const messages = state.allMessages.value
    const len = messages.length
    if (len === 0) {
      usedTokensScanCache = null
      return 0
    }

    const prefixCount = Math.max(0, len - 1)
    const version = getMessagesStructuralVersion(state)
    const scanCache = usedTokensScanCache
    const prefixOk = scanCache !== null && scanCache.messagesRef === messages
      && scanCache.scannedCount <= prefixCount && scanCache.version === version
    let prefix: UsedTokensScanOutput = {
      lastAssistantUsage: undefined,
      latestSummaryEstimate: undefined
    }
    scanUsedTokensRange(messages, prefixOk ? scanCache!.scannedCount : 0, prefixCount, prefix)
    if (prefixOk) prefix = mergeUsedTokensScan(scanCache!, prefix)

    usedTokensScanCache = {
      scannedCount: prefixCount,
      messagesRef: messages,
      ...prefix,
      version
    }

    const tail: UsedTokensScanOutput = { lastAssistantUsage: undefined, latestSummaryEstimate: undefined }
    scanUsedTokensRange(messages, prefixCount, len, tail)
    const out = mergeUsedTokensScan(prefix, tail)

    if (!out.lastAssistantUsage) return 0
    // 总结消息会插入到被压缩范围的末尾，数组位置早于保留消息；用 timestamp 判断
    // 它是否发生在这条旧 usage 之后。下一次真实主回复到达后自然恢复使用真实值。
    if (out.latestSummaryEstimate && out.latestSummaryEstimate.timestamp >= out.lastAssistantUsage.timestamp) {
      return out.latestSummaryEstimate.tokens
    }
    return out.lastAssistantUsage.totalTokenCount
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
    if (!lastMessage.isFunctionResponse && lastMessage.source !== 'background_task') return false
    // 本地占位/未终结的流式消息不算“已中断回合”：localOnly 占位可能马上被清理、
    // streaming 消息仍在收尾，此时显示“继续对话”按钮会误导用户
    if (lastMessage.localOnly || lastMessage.streaming) return false

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
