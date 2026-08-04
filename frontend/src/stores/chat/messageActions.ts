/**
 * Chat Store 消息操作
 * 
 * 包含消息发送、重试、编辑、删除等操作
 */

import type { Message, Attachment, Content } from '../../types'
import type { ChatStoreState, ChatStoreComputed, AttachmentData, ErrorInfo } from './types'
import { triggerRef } from 'vue'
import { sendToExtension } from '../../utils/vscode'
import { generateId } from '../../utils/format'
import {
  createAndPersistConversation,
  MESSAGES_PAGE_SIZE,
  loadCheckpoints,
  refreshCurrentConversationBuildSession,
  syncConversationWorkspaceUri
} from './conversationActions'
import { updateTabConversationId, updateTabTitle } from './tabActions'
import { clearCheckpointsFromIndex } from './checkpointActions'
import { contentToMessageEnhanced } from './parsers'
import { syncTotalMessagesFromWindow, setTotalMessagesFromWindow, trimWindowFromTop } from './windowUtils'
import { persistConversationModelConfig, persistConversationPromptMode } from './configActions'
import { validateSessionIdentity } from './utils'
import { rebuildMessageIndexById } from './state'
import { saveTailVersionForRetry, resetActiveTailVersionsForConversation, setActiveTailVersion } from './tailVersionActions'

/**
 * 安全写入错误信息（支持对话切换隔离）
 *
 * 如果当前活跃对话与请求发起时相同，直接写入全局 state.error；
 * 否则将错误写入原对话对应标签页的快照，避免跨对话错误泄漏。
 *
 * @param state  Chat Store 状态
 * @param originConvId 请求发起时的 conversationId（可能为 null，如新建对话场景）
 * @param error  要写入的错误信息
 */
function safeSetError(
  state: ChatStoreState,
  originConvId: string | null,
  error: ErrorInfo
): void {
  // 如果对话没有切换，或者原始对话 ID 为空（新建对话），直接写全局状态
  if (!originConvId || originConvId === state.currentConversationId.value) {
    state.error.value = error
   return
  }
  // 对话已切换 -> 写入原对话所在标签页的快照
  const tab = state.openTabs.value.find(t => t.conversationId === originConvId)
  if (tab) {
    const snapshot = state.sessionSnapshots.value.get(tab.id)
    if (snapshot) {
      snapshot.error = error
    }
  }
}

/**
 * 取消流式的回调类型
 */
export type CancelStreamCallback = () => Promise<void>

/**
 * 隐藏发送（不创建可见 user 消息）时，写入的一条 functionResponse
 */
export interface HiddenFunctionResponsePayload {
  id?: string
  approvalId?: string
  name: string
  response: Record<string, unknown>
}

export interface SendMessageOptions {
  modelOverride?: string
  hidden?: { functionResponse: HiddenFunctionResponsePayload }
  dynamicContextStrategyOverride?: 'single' | 'preserve'
  /** 消息来源，'background_task' 时前端渲染为后台任务卡片而非普通用户消息 */
  source?: 'user' | 'background_task'
}

/**
 * 计算后端消息索引
 *
 * 当前实现：前端的 allMessages 会存储所有消息（包括 functionResponse 消息），
 * 并且通过 loadHistory() 从后端加载时保持与后端历史索引一一对应。
 *
 * 因此这里直接返回 frontendIndex。
 *
 * 注意：如果未来再次调整为“前端不存 functionResponse”，才需要在这里做映射。
 */
export function calculateBackendIndex(messages: Message[], frontendIndex: number, windowStartIndex = 0): number {
  const msg = messages[frontendIndex]
  if (!msg) return -1
  if (typeof msg.backendIndex === 'number') return msg.backendIndex
  // 本地占位消息可能还没有 backendIndex：用窗口起点 + 本地偏移推导
  return windowStartIndex + frontendIndex
}

function getNextBackendIndex(state: ChatStoreState): number {
  return state.windowStartIndex.value + state.allMessages.value.length
}

function resolveConversationModelOverride(
  state: ChatStoreState,
  explicitOverride?: string
): string | undefined {
  if (typeof explicitOverride === 'string') {
    const trimmed = explicitOverride.trim()
    return trimmed || undefined
  }

  const selected = (state.selectedModelId.value || '').trim()
  const configModel = (state.currentConfig.value?.model || '').trim()
  return selected && selected !== configModel ? selected : undefined
}

function isEmptyAssistantPlaceholder(msg: Message | undefined): boolean {
  if (!msg) return false
  if (msg.role !== 'assistant') return false
  const hasContent = !!(msg.content && msg.content.trim())
  const hasTools = !!(msg.tools && msg.tools.length > 0)
  const hasPartsContent = !!msg.parts?.some(p => p.text || p.functionCall)
  return !hasContent && !hasTools && !hasPartsContent
}

function isLocalOnlyAssistant(msg: Message | undefined): boolean {
  return !!msg && msg.role === 'assistant' && msg.localOnly === true
}

/**
 * 发送消息
 */
function mergeResponseWithCleanup(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...(patch || {})
  }
}

function upsertHiddenFunctionResponseMessage(
  state: ChatStoreState,
  payload: HiddenFunctionResponsePayload
): void {
  const all = state.allMessages.value

  // 1) 优先按 id 定位并替换已有 functionResponse（如 create_plan 的原始响应）
  if (payload.id) {
    for (let i = all.length - 1; i >= 0; i--) {
      const msg = all[i]
      if (!msg.isFunctionResponse || !msg.parts || msg.parts.length === 0) continue

      let matched = false
      const nextParts = msg.parts.map(part => {
        const fr = part.functionResponse
        if (!fr) return part
        if (fr.id !== payload.id) return part

        matched = true
        return {
          ...part,
          functionResponse: {
            ...fr,
            id: payload.id || fr.id,
            name: payload.name,
            response: mergeResponseWithCleanup(fr.response as Record<string, unknown> | undefined, payload.response)
          }
        }
      })

      if (matched) {
        state.allMessages.value = [
          ...all.slice(0, i),
          { ...msg, parts: nextParts },
          ...all.slice(i + 1)
        ]
        // ★ 同步更新 toolResponseCache，避免 getToolResponseById 返回旧缓存
        // 导致 replayTodoStateFromMessages 看不到 planExecutionPrompt 等新合并字段
        if (payload.id) {
          const mergedResponse = nextParts
            .find(p => p.functionResponse?.id === payload.id)
            ?.functionResponse?.response as Record<string, unknown> | undefined
          if (mergedResponse) {
            state.toolResponseCache.value.set(payload.id, mergedResponse)
            triggerRef(state.toolResponseCache)
          }
        }
        return
      }
    }
  }

  // 2) 如果未命中，追加一条隐藏 functionResponse 消息
  const responseMessage: Message = {
    id: generateId(),
    role: 'user',
    content: '',
    timestamp: Date.now(),
    backendIndex: getNextBackendIndex(state),
    isFunctionResponse: true,
    parts: [{
      functionResponse: {
        id: payload.id,
        name: payload.name,
        response: payload.response
      }
    }]
  }
  state.allMessages.value.push(responseMessage)
}

export async function sendMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageText: string,
  attachments?: Attachment[],
  options?: SendMessageOptions
): Promise<boolean> {
  const hiddenFunctionResponse = options?.hidden?.functionResponse
  const isHiddenSend = !!hiddenFunctionResponse
  if (!isHiddenSend && !messageText.trim() && (!attachments || attachments.length === 0)) return false

  state.error.value = null
  if (state.isWaitingForResponse.value) return false

  // 发送新消息 = 放弃上次失败的回答：回滚失败流保留的半截消息，
  // 避免窗口中出现后端不存在的幽灵消息。
  rollbackFailedStreamMessage(state)
  
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 记录请求发起时的对话 ID，用于 catch 块中的对话切换检测
  let originConvId: string | null = state.currentConversationId.value
  // 本请求是否成功建立了流式占位（catch 中用它判断是否要展示发送错误，
  // 而不是依赖 isStreaming——取消竞态下 isStreaming 会被 cancelStream 复位）
  let streamStarted = false
  const effectiveModelOverride = resolveConversationModelOverride(state, options?.modelOverride)
  
  try {
    if (!state.currentConversationId.value) {
      const newId = await createAndPersistConversation(state, messageText)
      if (!newId) {
        throw new Error('Failed to create conversation')
      }
      originConvId = newId
      // 更新当前标签页的 conversationId 和标题
      if (state.activeTabId.value) {
        updateTabConversationId(state, state.activeTabId.value, newId)
        const title = messageText.slice(0, 30) + (messageText.length > 30 ? '...' : '')
        updateTabTitle(state, state.activeTabId.value, title)
      }

      await persistConversationModelConfig(state)
      await persistConversationPromptMode(state)
    }

    // 固化目标会话 ID：此后所有会话标识读写以此为准，避免多次 await 后重读 currentConversationId
    const targetConvId = state.currentConversationId.value
    if (!targetConvId) {
      throw new Error('No conversation ID after creation')
    }

    if (hiddenFunctionResponse) {
      // 隐藏模式：不创建可见 user 消息，改为 functionResponse（可用于计划确认等场景）
      upsertHiddenFunctionResponseMessage(state, hiddenFunctionResponse)
    } else {
      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content: messageText,
        timestamp: Date.now(),
        backendIndex: getNextBackendIndex(state),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        source: options?.source
      }
      state.allMessages.value.push(userMessage)
    }

    // 新用户消息意味着尾部变化：重roll 分叉的活跃版本标记重置为「最新当前答案」
    resetActiveTailVersionsForConversation(state, targetConvId)

    const assistantMessageId = generateId()
    const displayModelVersion = effectiveModelOverride || computed.currentModelName.value
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backendIndex: getNextBackendIndex(state),
      streaming: true,
      localOnly: true,
      metadata: {
        modelVersion: displayModelVersion
      }
    }
    state.allMessages.value.push(assistantMessage)
    state.streamingMessageId.value = assistantMessageId
    syncTotalMessagesFromWindow(state)
    trimWindowFromTop(state)
    streamStarted = true

    const conv = state.conversations.value.find(c => c.id === targetConvId)
    if (conv) {
      conv.updatedAt = Date.now()
      // 使用窗口推导的”已知总数”，避免窗口化后 messageCount 变小
      const knownTotal = Math.max(state.totalMessages.value, state.windowStartIndex.value + state.allMessages.value.length)
      state.totalMessages.value = knownTotal
      conv.messageCount = knownTotal
      if (!hiddenFunctionResponse) {
        conv.preview = messageText.slice(0, 50)
      }
    }

    await syncConversationWorkspaceUri(state, targetConvId)

    // 写入全局状态前校验会话归属，防止跨会话投递
    if (!validateSessionIdentity(state, targetConvId)) return false

    state.pendingModelOverride.value = effectiveModelOverride || null
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastApprovalGatedStreamId.value = null

    state._lastCancelledStreamId.value = null

    const attachmentData: AttachmentData[] | undefined = attachments && attachments.length > 0
      ? attachments.map(att => ({
          // 隐藏模式默认不带附件（这里保留原有结构以兼容调用）
          id: att.id,
          name: att.name,
          type: att.type,
          size: att.size,
          mimeType: att.mimeType,
          data: att.data || '',
          thumbnail: att.thumbnail
        }))
      : undefined

    await sendToExtension('chatStream', {
      conversationId: targetConvId,
      configId: state.configId.value,
      message: messageText,
      attachments: hiddenFunctionResponse ? undefined : attachmentData,
      modelOverride: effectiveModelOverride,
      hiddenFunctionResponse,
      promptModeId: state.currentPromptModeId.value,
      dynamicContextStrategyOverride: options?.dynamicContextStrategyOverride,
      streamId
    })

  } catch (err: any) {
    // 发送失败的错误展示不依赖 isStreaming 判断：
    // 用户在 await 期间调用了 cancelStream 时 isStreaming 已被置 false，
    // 此时真正的发送失败（IPC 异常等）会被静默吞掉（M1）。
    // 用「流式是否在本请求中建立」判断是否展示错误。
    if (streamStarted) {
      safeSetError(state, originConvId, {
        code: err.code || 'SEND_ERROR',
        message: err.message || 'Failed to send message'
      })
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.activeStreamId.value = null
      state.isWaitingForResponse.value = false
    }
    return false
  } finally {
    state.isLoading.value = false
  }

  return true
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
 * 从指定消息重试
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
    state.allMessages.value.push(assistantMessage)
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

  // ★ 重roll 树状分叉：截断前先把「当前回答及其后续内容」保存为版本，
  // 新回答生成后可在消息上随时切回旧版本（DeepSeek 网页版交互）。
  // 失败不阻塞重roll 本身（版本保存是尽力而为的增强）。
  await saveTailVersionForRetry(state, originConvId, backendIndex)
  // 重roll 后该分支点的活跃尾部变为「最新当前答案」
  setActiveTailVersion(state, originConvId, backendIndex, null)

  state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
  clearCheckpointsFromIndex(state, backendIndex)
  setTotalMessagesFromWindow(state)

  try {
    const resp = await sendToExtension<any>('deleteMessage', {
      conversationId: originConvId,
      targetIndex: backendIndex
    })

    if (!resp?.success) {
      console.error('[messageActions] retryFromMessage: backend deleteMessage returned error:', resp)
      const err = resp?.error
      safeSetError(state, originConvId, {
        code: err?.code || 'DELETE_ERROR',
        message: err?.message || 'Failed to delete messages in backend'
      })

      // 尝试回滚：重新从后端拉取”最后一页”历史，避免前端与后端状态错位（避免全量拉取造成卡顿）
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
        console.error('[messageActions] retryFromMessage: failed to reload history after delete failure:', reloadErr)
      }

      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.activeStreamId.value = null
      state.isWaitingForResponse.value = false
      state.isLoading.value = false
      return
    }
  } catch (err) {
    console.error('Failed to delete messages from backend:', err)
  }

  
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
  state.allMessages.value.push(assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)
  
  try {
    const modelOverride = resolveConversationModelOverride(state)
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('retryStream', {
      conversationId: originConvId,
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
 * 错误后重试
 */
/**
 * 回滚上次流式失败保留的半截 assistant 消息（仅前端窗口，不含后端）。
 *
 * 该消息是前端占位消息（localOnly=true），后端在流式错误时从未持久化它，
 * 因此这里只删除窗口中的消息，并清除挂在该消息索引上的检查点，
 * 避免重试/继续后窗口与后端历史错位。
 *
 * @returns 被回滚消息的后端索引（-1 表示没有可回滚的消息）
 */
export function rollbackFailedStreamMessage(state: ChatStoreState): number {
  const failedMessageId = state._failedStreamMessageId.value
  state._failedStreamMessageId.value = null
  if (!failedMessageId) return -1

  const failedIndex = state.allMessages.value.findIndex(m => m.id === failedMessageId)
  if (failedIndex === -1) return -1

  const backendIndex = calculateBackendIndex(state.allMessages.value, failedIndex, state.windowStartIndex.value)
  state.allMessages.value = state.allMessages.value.slice(0, failedIndex)
  clearCheckpointsFromIndex(state, backendIndex)
  setTotalMessagesFromWindow(state)
  return backendIndex
}

/**
 * 关闭错误提示：同时清理失败流保留的半截消息（用户明确放弃该次回答）。
 */
export function dismissError(state: ChatStoreState): void {
  rollbackFailedStreamMessage(state)
  state.error.value = null
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

  // 记录请求发起时的对话 ID，用于 catch 块中的对话切换检测
  const originConvId = state.currentConversationId.value

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
  }

  state.error.value = null
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
  state.allMessages.value.push(assistantMessage)
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
 * 编辑并重发消息
 */
export async function editAndRetry(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageIndex: number,
  newMessage: string,
  attachments: Attachment[] | undefined,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if ((!newMessage.trim() && (!attachments || attachments.length === 0)) || !state.currentConversationId.value) return
  if (messageIndex < 0 || messageIndex >= state.allMessages.value.length) return

  // await cancelStream() 之前固化 key 参数
  const originConvId = state.currentConversationId.value
  const targetMessageId = state.allMessages.value[messageIndex]?.id

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
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 计算后端索引（在修改数组之前）
  const backendMessageIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)
  
  const targetMessage = state.allMessages.value[messageIndex]
  targetMessage.content = newMessage
  targetMessage.parts = [{ text: newMessage }]
  targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined
  
  state.allMessages.value = state.allMessages.value.slice(0, messageIndex + 1)
  clearCheckpointsFromIndex(state, backendMessageIndex)
  setTotalMessagesFromWindow(state)

  // 编辑用户消息也会改变后续尾部：重置重roll 分叉的活跃版本标记
  resetActiveTailVersionsForConversation(state, originConvId)

  
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
  state.allMessages.value.push(assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)
  
  const attachmentData: AttachmentData[] | undefined = attachments && attachments.length > 0
    ? attachments.map(att => ({
        id: att.id,
        name: att.name,
        type: att.type,
        size: att.size,
        mimeType: att.mimeType,
        data: att.data || '',
        thumbnail: att.thumbnail
      }))
    : undefined
  
  try {
    const modelOverride = resolveConversationModelOverride(state)
    const streamId = generateId()
    state.activeStreamId.value = streamId
    state._lastCancelledStreamId.value = null
    await sendToExtension('editAndRetryStream', {
      conversationId: originConvId,
      messageIndex: backendMessageIndex,
      newMessage,
      attachments: attachmentData,
      configId: state.configId.value,
      modelOverride,
      streamId,
      promptModeId: state.currentPromptModeId.value
    })
  } catch (err: any) {
    if (state.isStreaming.value) {
      safeSetError(state, originConvId, {
        code: err.code || 'EDIT_RETRY_ERROR',
        message: err.message || 'Edit and retry failed'
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

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换，目标消息可能已变化
  if (state.currentConversationId.value !== originConvId) return
  if (!isLocalPlaceholder && state.allMessages.value[targetIndex]?.id !== targetMessageId) return

  // 如果删除目标是”本地空占位 assistant”（后端并不存在），只做本地删除，避免后端索引越界。
  if (isLocalPlaceholder) {
    const msgId = state.allMessages.value[targetIndex]?.id
    // 重新计算（可能因为 cancel 导致窗口变化）
    const currentBackendFrom = calculateBackendIndex(state.allMessages.value, targetIndex, state.windowStartIndex.value)
    state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
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
      targetIndex: backendIndex
    })

    // 再次校验归属
    if (state.currentConversationId.value !== originConvId) return

    if (response?.success) {
      state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
      clearCheckpointsFromIndex(state, backendIndex)
      setTotalMessagesFromWindow(state)
      // 删除后续消息：重置重roll 分叉的活跃版本标记
      resetActiveTailVersionsForConversation(state, originConvId)
      await refreshCurrentConversationBuildSession(state)
    } else {
      const err = response?.error
      safeSetError(state, originConvId, {
        code: err?.code || 'DELETE_ERROR',
        message: err?.message || 'Delete failed'
      })
      console.error('[messageActions] deleteMessage failed:', response)
    }
  } catch (err: any) {
    safeSetError(state, originConvId, {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Delete failed'
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

  // 如果正在流式响应或等待工具确认，先取消
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    await cancelStream()
  }

  // 校验归属：cancel 期间当前会话可能已切换
  if (state.currentConversationId.value !== originConvId) return

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

      // 删除单条消息也会改变尾部：重置重roll 分叉的活跃版本标记
      resetActiveTailVersionsForConversation(state, originConvId)

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
