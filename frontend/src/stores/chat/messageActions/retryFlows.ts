/**
 * 重试家族（从 messageActions.ts 拆出）。
 *
 * 包含 retryLastMessage / retryFromMessage / retryAfterError / editAndRetry 及私有辅助
 * （recoverAfterStreamStartFailure / replayBranchStreamAfterError / 可重试错误码判定等）。
 *
 * 逻辑逐字迁移：reroll / 编辑分支语义（TREE-01 / TREE-03）、分支流失败恢复、
 * 会话切换隔离等已修 bug 注释原样保留，一行未改。
 *
 * 依赖方向：本模块单向导入 sendMessageFlow 的共享工具（safeSetError /
 * getNextBackendIndex / resolveConversationModelOverride / rollbackFailedStreamMessage /
 * calculateBackendIndex），并被 deleteFlows 单向导入（isEmptyAssistantPlaceholder /
 * isLocalOnlyAssistant）。
 */

import type { Message, Content, Attachment } from '../../../types'
import type { ChatStoreState, ChatStoreComputed, ErrorInfo, BranchStreamReplayContext } from '../types'
import { sendToExtension } from '../../../utils/vscode'
import { generateId } from '../../../utils/format'
import { MESSAGES_PAGE_SIZE, loadCheckpoints } from '../conversationActions'
import { clearCheckpointsFromIndex } from '../checkpointActions'
import { contentToMessageEnhanced } from '../parsers'
import { syncTotalMessagesFromWindow, setTotalMessagesFromWindow, trimWindowFromTop } from '../windowUtils'
import { validateSessionIdentity } from '../utils'
import { rebuildMessageIndexById, appendMessage } from '../state'
import { translate } from '../../../composables/useI18n'
import { useSettingsStore } from '../../settingsStore'
import {
  safeSetError,
  getNextBackendIndex,
  resolveConversationModelOverride,
  rollbackFailedStreamMessage,
  calculateBackendIndex
} from './sendMessageFlow'
import type { CancelStreamCallback } from './sendMessageFlow'

export function isEmptyAssistantPlaceholder(msg: Message | undefined): boolean {
  if (!msg) return false
  if (msg.role !== 'assistant') return false
  const hasContent = !!(msg.content && msg.content.trim())
  const hasTools = !!(msg.tools && msg.tools.length > 0)
  const hasPartsContent = !!msg.parts?.some(p => p.text || p.functionCall || p.inlineData || p.fileData)
  return !hasContent && !hasTools && !hasPartsContent
}

export function isLocalOnlyAssistant(msg: Message | undefined): boolean {
  return !!msg && msg.role === 'assistant' && msg.localOnly === true
}

/**
 * 重试最后一条消息
 */
export async function retryLastMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (state.allMessages.value.length === 0) return
  let lastAssistantIndex = -1
  for (let i = state.allMessages.value.length - 1; i >= 0; i--) {
    if (state.allMessages.value[i].role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }
  if (lastAssistantIndex !== -1) {
    await retryFromMessage(state, computed, lastAssistantIndex, cancelStream)
  }
}

/**
 * retryFromMessage：reroll 流启动失败（IPC 抛异常）后的统一恢复。
 *
 * 此时本地已截断窗口（slice + clearCheckpointsFromIndex），而后端主历史可能未截断
 * （rerollStream 未送达 / handler 同步抛错）；这里重载最后一页 + 检查点恢复前后端一致，
 * 并复位流式状态与 reroll 分支图刷新标记，中止本次 reroll。
 */
async function recoverAfterStreamStartFailure(
  state: ChatStoreState,
  originConvId: string
): Promise<void> {
  state._pendingBranchRefreshAfterStream.value = null
  state._pendingBranchReplayContext.value = null
  // 尝试回滚：重新从后端拉取“最后一页”历史，避免前端与后端状态错位（避免全量拉取造成卡顿）
  try {
    const result = await sendToExtension<{ total: number; messages: Content[] }>('conversation.getMessagesPaged', {
      conversationId: originConvId,
      limit: MESSAGES_PAGE_SIZE
    })
    const page = result?.messages || []
    state.totalMessages.value = result?.total ?? page.length
    state.windowStartIndex.value = page[0]?.index ?? 0
    state.allMessages.value = page.map(content => contentToMessageEnhanced(content))
    rebuildMessageIndexById(state)
  } catch (reloadErr) {
    console.error('[messageActions] retryFromMessage: failed to reload history after reroll start failure:', reloadErr)
  }

  // 失败重载历史后同步重载检查点——getMessagesPaged 只拉消息页，不重载 checkpoints，
  // 否则后端历史未删、检查点仍存在，而前端窗口只有消息没有存档条（前后端不一致）。
  if (state.currentConversationId.value === originConvId) {
    try {
      await loadCheckpoints(state)
    } catch (reloadErr) {
      console.error('[messageActions] retryFromMessage: failed to reload checkpoints after reroll start failure:', reloadErr)
    }
  }

  state.streamingMessageId.value = null
  state.isStreaming.value = false
  state.activeStreamId.value = null
  state.isWaitingForResponse.value = false
  state.isLoading.value = false
}

/**
 * 从指定消息重试（TREE-01：主流程走 reroll——保留旧回答，生成新候选）。
 *
 * 语义变化：不再调用 deleteMessage 破坏性删除旧回答；后端 chat.rerollStream 会把旧回答
 * 移入分支图 sidecar 并创建新候选（旧候选可切换回来，BranchSwitcherBar 显示 ‹ 2/2 ›）。
 * 本地空占位（后端不存在）仍走 retryStream 兼容路径（决策 5）。
 */
export async function retryFromMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value || state.allMessages.value.length === 0) return
  if (messageIndex < 0 || messageIndex >= state.allMessages.value.length) return

  // await cancelStream() 之前固化 key 参数
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id
  if (!targetMessageId) return
  const isLocalPlaceholder = isLocalOnlyAssistant(state.allMessages.value[messageIndex]) || isEmptyAssistantPlaceholder(state.allMessages.value[messageIndex])

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换
  if (state.currentConversationId.value !== originConvId) return
  // 校验消息标识：cancel 后目标消息可能已变化
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  // 如果目标是”本地空占位 assistant”（后端并不存在），不要调用 deleteMessage 到后端，
  // 否则会触发 messageIndexOutOfBounds。这里直接本地清理并走 retryStream。
  if (isLocalPlaceholder) {
    state.error.value = null
    state._pendingBranchReplayContext.value = null
    state.isLoading.value = true
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true

    const backendFrom = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)
    state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
    clearCheckpointsFromIndex(state, backendFrom)
    setTotalMessagesFromWindow(state)

    const assistantMessageId = generateId()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: getNextBackendIndex(state),
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: computed.currentModelName.value
      }
    }
    appendMessage(state, assistantMessage)
    state.streamingMessageId.value = assistantMessageId
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)

    try {
      const modelOverride = resolveConversationModelOverride(state)
      const streamId = generateId()
      state.activeStreamId.value = streamId
      state._lastCancelledStreamId.value = null
      await sendToExtension('retryStream', {
        conversationId: state.currentConversationId.value,
        configId: state.configId.value,
        modelOverride,
        streamId,
        promptModeId: state.currentPromptModeId.value
      })
    } catch (err: any) {
      if (state.isStreaming.value) {
        safeSetError(state, originConvId, {
          code: err.code || 'RETRY_ERROR',
          message: err.message || 'Retry failed'
        })
        state.streamingMessageId.value = null
        state.isStreaming.value = false
        state.activeStreamId.value = null
        state.isWaitingForResponse.value = false
      }
    } finally {
      state.isLoading.value = false
    }
    return
  }
  
  state.error.value = null
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 计算后端索引（在修改数组之前）
  const backendIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)

  // TREE-01：reroll 语义——本地截断窗口（旧回答从活跃路径移除，后端 startReroll 会将其
  // 保留进分支图 sidecar 并截断主历史），不再调用 deleteMessage（破坏性删除已废弃）。
  state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
  clearCheckpointsFromIndex(state, backendIndex)
  setTotalMessagesFromWindow(state)

  const assistantMessageId = generateId()
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    backendIndex: getNextBackendIndex(state),
    streaming: true,
    localOnly: true,
    metadata: {
      modelVersion: computed.currentModelName.value
    }
  }
  appendMessage(state, assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)

  // 置位：流结束（complete/error/cancelled）后刷新分支图，
  // 让 BranchSwitcherBar 显示新候选的「‹ 2/2 ›」切换器（streamHandler 按会话消费并复位）。
  state._pendingBranchRefreshAfterStream.value = originConvId

  let replayContext: BranchStreamReplayContext | null = null
  try {
    const modelOverride = resolveConversationModelOverride(state)
    replayContext = {
      kind: 'reroll',
      conversationId: originConvId,
      assistantNodeId: targetMessageId,
      configId: state.configId.value,
      modelOverride,
      promptModeId: state.currentPromptModeId.value
    }
    state._pendingBranchReplayContext.value = replayContext
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('chat.rerollStream', {
      conversationId: originConvId,
      // 目标 assistant 消息的稳定节点 ID（BR-01：Content.id 与 BranchGraph 节点 id 对齐）
      assistantNodeId: targetMessageId,
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value
    })
  } catch (err: any) {
    const branchReplayContext = replayContext
    if (state._pendingBranchReplayContext.value?.conversationId === originConvId) {
      state._pendingBranchReplayContext.value = null
    }
    // 本次 reroll 已中止：无论会话是否切换，先复位分支图刷新标记，避免后续终结事件误消费
    state._pendingBranchRefreshAfterStream.value = null
    if (state.isStreaming.value) {
      safeSetError(state, originConvId, {
        code: err.code || 'RETRY_ERROR',
        message: err.message || 'Retry failed',
        branchReplayContext: branchReplayContext ?? undefined
      })
    }
    // 会话已切换时不恢复：窗口已由新会话 loadHistory 接管，重载原会话历史会污染当前窗口（与 editAndRetry 同款）
    if (validateSessionIdentity(state, originConvId)) {
      await recoverAfterStreamStartFailure(state, originConvId)
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 关闭错误提示：同时清理失败流保留的半截消息（用户明确放弃该次回答）。
 */
export function dismissError(state: ChatStoreState): void {
  rollbackFailedStreamMessage(state)
  state._pendingBranchReplayContext.value = null
  state.error.value = null
}

/**
 * 可重试错误码集合（H-3 + FIX-C-1）。
 * 与 backend/core/errors.ts 同步维护（后端 ChannelError.type 可重试白名单；
 * 本集合另有 STREAM_ERROR 等前端自有码）。
 *
 * 错误条“重试”按钮仅在这些错误码时显示/启用：普通流错误继续走 retryStream；
 * reroll / 编辑分支错误由 ErrorInfo.branchReplayContext 重放原分支流。
 *
 * FIX-C-1：后端流式错误 chunk 的 code 来自 backend/modules/channel/types.ts 的
 * ChannelError.type（CONFIG_ERROR/NETWORK_ERROR/API_ERROR/PARSE_ERROR/VALIDATION_ERROR/
 * TIMEOUT_ERROR/CANCELLED_ERROR）或 UNKNOWN_ERROR——真实流式失败（余额不足/断网/5xx）
 * 以此到达前端。并入可重试集合（修复 B7 引入的功能回归）：
 * - API_ERROR / NETWORK_ERROR / TIMEOUT_ERROR / PARSE_ERROR：可重试（重试有意义）
 * - CANCELLED_ERROR（用户主动取消）、CONFIG_ERROR / VALIDATION_ERROR（配置/参数问题，
 *   重试无意义）、UNKNOWN_ERROR（语义不明，保守不重试）不在此列。
 *
 * 恢复/预览类错误（RESTORE_ERROR / RESTORE_PARTIAL_ERROR / RESTORE_UNBACKED_WARNING /
 * RESTORE_PREVIEW_ERROR 等）不在此列：对它们点击“重试”不应触发 LLM 重新生成（H-3 语义不变）。
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'STREAM_ERROR',
  'RETRY_ERROR',
  'EDIT_RETRY_ERROR',
  'API_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT_ERROR',
  'PARSE_ERROR'
])

/**
 * 错误是否可重试（H-3）：仅流式生成类错误码允许通过错误条“重试”。
 *
 * REROLL_ERROR / EDIT_BRANCH_ERROR（reroll/编辑分支流失败，方案 B）：可重试性取决于
 * 底层 ChannelError.type（后端流式失败时透传）——type 属于可重试集合成员时判定可重试；
 * 无 type（reroll 特有错误，如 REROLL_FINISH_SYNC_FAILED，不属于底层流错误）或 type 不可重试
 * （CONFIG_ERROR / VALIDATION_ERROR / CANCELLED_ERROR 等）时不可重试。
 */
export function isRetryableError(error: ErrorInfo | null | undefined): boolean {
  if (!error) return false
  if (error.code === 'REROLL_ERROR' || error.code === 'EDIT_BRANCH_ERROR') {
    return !!error.type && RETRYABLE_ERROR_CODES.has(error.type)
  }
  return RETRYABLE_ERROR_CODES.has(error.code)
}

function isMatchingBranchReplayError(error: ErrorInfo, context: BranchStreamReplayContext): boolean {
  if (context.kind === 'reroll') {
    return error.code === 'REROLL_ERROR' || error.code === 'RETRY_ERROR'
  }
  return error.code === 'EDIT_BRANCH_ERROR' || error.code === 'EDIT_RETRY_ERROR'
}

/**
 * 失败后重放 reroll / 编辑分支流。
 *
 * 流式失败时后端已经把新候选切成活跃路径，原始目标已经进入 sidecar：此时不再发送旧节点 ID，
 * 由后端按当前活跃路径解析最新 model/user 节点。请求级失败尚未改动后端状态，则继续使用原始目标 ID。
 */
async function replayBranchStreamAfterError(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  error: ErrorInfo,
  context: BranchStreamReplayContext
): Promise<void> {
  const originConvId = state.currentConversationId.value
  if (!originConvId || context.conversationId !== originConvId) return

  const isStreamLevelFailure = error.code === 'REROLL_ERROR' || error.code === 'EDIT_BRANCH_ERROR'

  if (isStreamLevelFailure) {
    // 分支流失败候选由后端保留；这里只移除前端半截展示，绝不能调用 deleteMessage 破坏分支图。
    rollbackFailedStreamMessage(state)
  } else {
    // 请求级失败尚未启动后端分支操作：按原请求重新构造本地活跃窗口。
    const targetId = context.kind === 'reroll' ? context.assistantNodeId : context.userNodeId
    const targetIndex = state.allMessages.value.findIndex(message => message.id === targetId)
    if (targetIndex === -1) return

    const backendIndex = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)
    const isKeepReplay = context.kind === 'editBranch' && context.mode === 'keep'
    if (context.kind === 'reroll') {
      state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
    } else {
      const targetMessage = state.allMessages.value[targetIndex]
      targetMessage.content = context.newText
      targetMessage.parts = [{ text: context.newText }]
      // keep 模式（真·原地保存）：只改写目标消息，后续消息全部保留，不截断
      if (!isKeepReplay) {
        state.allMessages.value = state.allMessages.value.slice(0, targetIndex + 1)
      }
    }
    if (!isKeepReplay) {
      clearCheckpointsFromIndex(state, backendIndex)
      setTotalMessagesFromWindow(state)
    }
  }

  state.error.value = null
  state.isLoading.value = true

  // keep 模式（真·原地保存）重放：不创建占位（后端不重新生成，complete 仅复位状态），
  // 同样不进入流式等待状态——否则终结事件丢失时 isStreaming 残留，后续发消息全部被拦截
  const isKeepReplay = context.kind === 'editBranch' && context.mode === 'keep'
  if (!isKeepReplay) {
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    const assistantMessageId = generateId()
    appendMessage(state, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: getNextBackendIndex(state),
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: computed.currentModelName.value
      }
    })
    state.streamingMessageId.value = assistantMessageId
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
  }

  state._pendingBranchRefreshAfterStream.value = isKeepReplay ? null : originConvId
  state._pendingBranchReplayContext.value = context

  try {
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null

    if (context.kind === 'reroll') {
      await sendToExtension('chat.rerollStream', {
        conversationId: originConvId,
        // 流式失败后原目标已离开活跃路径；省略 ID 让后端选择当前活跃 model 尾节点。
        ...(isStreamLevelFailure ? {} : { assistantNodeId: context.assistantNodeId }),
        configId: context.configId,
        modelOverride: context.modelOverride,
        streamId,
        promptModeId: context.promptModeId
      })
    } else {
      await sendToExtension('chat.editBranchStream', {
        conversationId: originConvId,
        // 流式失败后编辑候选仍在活跃路径；省略 ID 让后端选择当前活跃 user 尾节点。
        ...(isStreamLevelFailure ? {} : { userNodeId: context.userNodeId }),
        newText: context.newText,
        configId: context.configId,
        modelOverride: context.modelOverride,
        streamId,
        promptModeId: context.promptModeId,
        mode: context.mode ?? 'branch'
      })
    }
  } catch (err: any) {
    const branchReplayContext = context
    if (state._pendingBranchReplayContext.value?.conversationId === originConvId) {
      state._pendingBranchReplayContext.value = null
    }
    state._pendingBranchRefreshAfterStream.value = null
    // keep 重放不设置 isStreaming：错误显示不能依赖该标志
    if (state.isStreaming.value || isKeepReplay) {
      safeSetError(state, originConvId, {
        code: err.code || (context.kind === 'reroll' ? 'RETRY_ERROR' : 'EDIT_RETRY_ERROR'),
        message: err.message || (context.kind === 'reroll' ? 'Retry failed' : 'Edit and retry failed'),
        branchReplayContext
      })
    }
    if (validateSessionIdentity(state, originConvId)) {
      await recoverAfterStreamStartFailure(state, originConvId)
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 错误后重试
 */
export async function retryAfterError(
  state: ChatStoreState,
  computed: ChatStoreComputed
): Promise<void> {
  if (!state.currentConversationId.value) return
  if (state.isLoading.value || state.isStreaming.value) return

  // H-3: 恢复/预览类错误不是 LLM 流式错误——点击重试会错误地触发 retryStream 重新生成。
  // 只有可重试错误码才继续；恢复类结果由独立提示（MessageList restoreNotice）展示。
  // 注：needsContinueButton 仅在 error 为空时成立，因此“继续对话”不受此守卫影响。
  const currentError = state.error.value
  if (currentError && !isRetryableError(currentError)) {
    return
  }

  // 记录请求发起时的对话 ID，用于 catch 块中的对话切换检测
  const originConvId = state.currentConversationId.value

  const branchReplayContext = currentError?.branchReplayContext
  if (currentError && branchReplayContext && isMatchingBranchReplayError(currentError, branchReplayContext)) {
    await replayBranchStreamAfterError(state, computed, currentError, branchReplayContext)
    return
  }
  // 分支流错误如果丢失了重放上下文，宁可保留错误也不能退回 retryStream 污染分支图。
  if (currentError?.code === 'REROLL_ERROR' || currentError?.code === 'EDIT_BRANCH_ERROR') {
    return
  }

  // 失败流回滚：清理上次流式失败保留的半截 assistant 消息，
  // 避免重试后窗口/历史出现半截回答残留。
  const failedMessage = state.allMessages.value.find(m => m.id === state._failedStreamMessageId.value)
  const backendIndex = rollbackFailedStreamMessage(state)

  // 防御性兜底：极端情况下半截消息已被标记为非 localOnly（后端可能已持久化），
  // 同步删除后端对应消息，避免重试后历史残留。
  if (backendIndex !== -1 && failedMessage && !failedMessage.localOnly && typeof failedMessage.backendIndex === 'number') {
    try {
      await sendToExtension<any>('deleteMessage', {
        conversationId: originConvId,
        targetIndex: backendIndex
      })
    } catch (err) {
      console.error('[messageActions] retryAfterError: failed to delete partial message in backend:', err)
    }
    // FIX-C-4：await 后校验会话归属——await 期间当前会话可能已切换，
    // 中止后续写操作（清错误/建占位/retryStream 都不应落到新会话）。
    if (!validateSessionIdentity(state, originConvId)) return
  }

  state.error.value = null
  state._pendingBranchReplayContext.value = null
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  
  const assistantMessageId = generateId()
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    backendIndex: getNextBackendIndex(state),
    streaming: true,
    localOnly: true,
    metadata: {
      modelVersion: computed.currentModelName.value
    }
  }
  appendMessage(state, assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)
  
  try {
    const modelOverride = resolveConversationModelOverride(state)
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('retryStream', {
      conversationId: state.currentConversationId.value,
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value
    })
  } catch (err: any) {
    if (state.isStreaming.value) {
      safeSetError(state, originConvId, {
        code: err.code || 'RETRY_ERROR',
        message: err.message || 'Retry failed'
      })
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.activeStreamId.value = null
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 编辑并重发消息（TREE-03：主流程走 chat.editBranchStream——创建编辑候选，不覆盖原消息；
 * mode='keep' 时原地改写原消息，保持当前分支）。
 */
export async function editAndRetry(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageIndex: number,
  newMessage: string,
  attachments: Attachment[] | undefined,
  cancelStream: CancelStreamCallback,
  mode: 'branch' | 'keep' = 'branch'
): Promise<void> {
  if ((!newMessage.trim() && (!attachments || attachments.length === 0)) || !state.currentConversationId.value) return
  if (messageIndex < 0 || messageIndex >= state.allMessages.value.length) return

  // await cancelStream() 之前固化 key 参数
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id
  if (!targetMessageId) return

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换
  if (state.currentConversationId.value !== originConvId) return
  // 校验消息标识：cancel 后目标消息可能已变化
  if (state.allMessages.value[messageIndex]?.id !== targetMessageId) return

  state.error.value = null
  state.isLoading.value = true

  // 计算后端索引（在修改数组之前）
  const backendMessageIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)
  
  const targetMessage = state.allMessages.value[messageIndex]
  // 根节点（parentId 为 null/undefined）：BranchGraph 单根模型下无父节点可挂「新 user 编辑
  // 节点」候选，但后端支持根节点编辑重生成：原地改写根节点文本 + 截断其后消息 + 新建模型
  // 候选重新生成（TREE-03-R：与普通编辑同一套 branch 语义，旧回答保留为可切换候选）。
  // 因此 branch 模式不再降级 keep；「原地保存（keep）」由用户在编辑对话框显式选择。
  const effectiveMode = mode
  targetMessage.content = newMessage
  targetMessage.parts = [{ text: newMessage }]
  targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined

  if (effectiveMode === 'keep') {
    // 真·原地保存：只改写本条消息，后续消息 / 检查点 / 分支全部保留，
    // 不截断窗口、不创建占位（后端不重新生成，complete 仅复位状态）。
    // 关键：**不进入流式等待状态**——不设置 isStreaming / isWaitingForResponse /
    // streamingMessageId。否则 complete 终结事件一旦丢失（视图重建 / IPC 抖动 /
    // 后端异常），状态永久残留，sendMessage 会把后续所有新消息拦截成
    // deliverInterruptMessage（投递到无人消费的主会话 inbox），表现为
    // 「无论如何都不发消息」。activeStreamId 仍由下方 try 块设置：
    // error chunk 按 streamId 路由到 handleError（错误条可见）。
  } else {
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    // branch 模式：截断窗口到目标消息 + 创建流式占位
    state.allMessages.value = state.allMessages.value.slice(0, messageIndex + 1)
    clearCheckpointsFromIndex(state, backendMessageIndex)
    setTotalMessagesFromWindow(state)

    const assistantMessageId = generateId()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: getNextBackendIndex(state),
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: computed.currentModelName.value
      }
    }
    appendMessage(state, assistantMessage)
    state.streamingMessageId.value = assistantMessageId
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
  }

  // 置位：流结束（complete/error/cancelled）后刷新分支图，
  // 让 BranchSwitcherBar 显示新编辑候选的「‹ 2/2 ›」切换器（streamHandler 按会话消费并复位）。
  // keep 模式（真·原地保存）不产生候选，无需刷新分支图。
  if (effectiveMode !== 'keep') {
    state._pendingBranchRefreshAfterStream.value = originConvId
  }

  let replayContext: BranchStreamReplayContext | null = null
  try {
    const modelOverride = resolveConversationModelOverride(state)
    replayContext = {
      kind: 'editBranch',
      conversationId: originConvId,
      userNodeId: targetMessageId,
      newText: newMessage,
      configId: state.configId.value,
      modelOverride,
      promptModeId: state.currentPromptModeId.value,
      mode: effectiveMode
    }
    state._pendingBranchReplayContext.value = replayContext
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    // TREE-03：主流程走 chat.editBranchStream——后端创建编辑候选（新 user 节点），
    // 原消息及其子树保留进分支图 sidecar（决策 7/10：不覆盖原消息、失败可切回）。
    // 注意：编辑分支接口无附件字段（后端 EditBranchRequestData 仅文本 parts），
    // 附件只更新本地窗口（targetMessage.attachments 已在上方处理）。
    await sendToExtension('chat.editBranchStream', {
      conversationId: originConvId,
      // 被编辑用户消息的稳定节点 ID（BR-01：Content.id 与 BranchGraph 节点 id 对齐）
      userNodeId: targetMessageId,
      // 索引漂移校验：后端据 messageId 校验目标消息未被其他请求移动
      messageId: targetMessageId,
      newText: newMessage,
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value,
      // 根节点 branch：后端原地改写根节点 + 截断其后 + 重新生成（TREE-03-R），
      // 与普通编辑同一套候选语义；keep 仅在用户显式选择「原地保存」时透传
      mode: effectiveMode
    })
  } catch (err: any) {
    const branchReplayContext = replayContext
    if (state._pendingBranchReplayContext.value?.conversationId === originConvId) {
      state._pendingBranchReplayContext.value = null
    }
    // 编辑分支流启动失败（IPC 抛异常）：后端可能未创建编辑候选/未截断主历史，
    // 而本地窗口已截断并改写——重载最后一页 + 检查点恢复前后端一致，
    // 并复位流式状态与分支图刷新标记（与 reroll 的 recoverAfterStreamStartFailure 同模式）。
    // 错误条仍显示 EDIT_RETRY_ERROR（可重试），但重试基于重载后的真实后端历史。
    // 注意：无论会话是否切换，本次编辑分支流都已中止，分支图刷新标记必须复位，避免残留误消费。
    state._pendingBranchRefreshAfterStream.value = null
    // keep 模式不设置 isStreaming：错误显示不能依赖该标志，否则 IPC 层失败时错误静默丢失
    if (state.isStreaming.value || effectiveMode === 'keep') {
      // MESSAGE_CHANGED：目标消息已被其他操作改动（索引漂移校验失败），提示用户刷新历史，
      // 不附带 branchReplayContext（重放已无意义）
      const isMessageChanged = err?.code === 'MESSAGE_CHANGED'
      safeSetError(state, originConvId, {
        code: isMessageChanged ? 'MESSAGE_CHANGED' : (err.code || 'EDIT_RETRY_ERROR'),
        message: isMessageChanged
          ? translate(useSettingsStore().language || 'zh-CN', 'stores.chatStore.errors.messageChanged')
          : (err.message || 'Edit and retry failed'),
        branchReplayContext: isMessageChanged ? undefined : (branchReplayContext ?? undefined)
      })
    }
    // 会话已切换时不恢复：窗口已由新会话 loadHistory 接管，避免跨会话污染
    if (validateSessionIdentity(state, originConvId)) {
      await recoverAfterStreamStartFailure(state, originConvId)
    }
  } finally {
    state.isLoading.value = false
  }
}
