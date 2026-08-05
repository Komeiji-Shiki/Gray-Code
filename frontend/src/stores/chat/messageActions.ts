/**
 * Chat Store 消息操作
 * 
 * 包含消息发送、重试、编辑、删除等操作
 */

import type { Message, Attachment, Content } from '../../types'
import type { ChatStoreState, ChatStoreComputed, AttachmentData, ErrorInfo, BranchStreamReplayContext } from './types'
import { triggerRef, shallowRef } from 'vue'
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
import { rebuildMessageIndexById, appendMessage } from './state'
import { translate } from '../../composables/useI18n'
import { useSettingsStore } from '../settingsStore'

/**
 * H5：复位“本次 sendMessage 遗留的流式/待发送状态”。
 *
 * sendMessage 在 await 间隙提前终止（如会话已切换导致 validateSessionIdentity 失败）
 * 时必须复位本次发送设置的标志，否则 isStreaming/isWaitingForResponse/streamingMessageId
 * 会永久残留，界面一直卡在“等待响应”。
 */
function resetPendingSendState(state: ChatStoreState): void {
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false
  state._lastCancelledStreamId.value = null
}

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
 * 用户消息插入（U1）单条文本长度上限（与后端 mailbox 约定一致）
 */
export const INTERRUPT_MESSAGE_MAX_LENGTH = 4000

/**
 * U1（用户消息插入）投递结果的轻量回显状态（M3-1）。
 *
 * 忙时投递只把用户消息写入主会话 inbox，窗口内不落任何痕迹、不推 chunk；
 * 这里记录「最近投递 / 投递失败」状态，由 MessageList 在消息区给出轻量提示：
 * - ① 投递成功：提示「已投递，将在当前回合结束后处理」，避免用户看不到结果；
 * - ③ 投递失败（如 INTERRUPT_MESSAGE_RATE_LIMITED）：给出可见错误反馈，
 *   不写 state.error（避免打断进行中的回合）。
 */
export interface InterruptDeliveryNotice {
  conversationId: string
  text: string
  kind: 'delivered' | 'error'
  errorCode?: string
  errorMessage?: string
  createdAt: number
}

/** 提示保留时长：超过后自动从列表中移除 */
export const INTERRUPT_NOTICE_TTL_MS = 10_000
/** 同一时刻最多保留的投递提示条数（防御性兜底） */
export const INTERRUPT_NOTICE_MAX = 3

export const recentInterruptDeliveries = shallowRef<InterruptDeliveryNotice[]>([])

/** 记录一条投递提示：同一会话同类型只保留最新一条；超出上限丢弃最旧；TTL 后自动移除 */
export function recordInterruptDelivery(notice: Omit<InterruptDeliveryNotice, 'createdAt'>): void {
  const full: InterruptDeliveryNotice = { ...notice, createdAt: Date.now() }
  const filtered = recentInterruptDeliveries.value.filter(
    n => !(n.conversationId === full.conversationId && n.kind === full.kind)
  )
  recentInterruptDeliveries.value = [full, ...filtered].slice(0, INTERRUPT_NOTICE_MAX)
  setTimeout(() => {
    recentInterruptDeliveries.value = recentInterruptDeliveries.value.filter(n => n.createdAt !== full.createdAt)
  }, INTERRUPT_NOTICE_TTL_MS)
}

/** 清除指定会话的投递提示（当前回合结束时由 MessageList 调用） */
export function clearInterruptDeliveries(conversationId: string): void {
  recentInterruptDeliveries.value = recentInterruptDeliveries.value.filter(n => n.conversationId !== conversationId)
}

/**
 * 忙时投递（U1）：把用户消息改走 chat.sendInterruptMessage（主会话收件箱）。
 *
 * - 不排队、不乐观插入窗口、不创建 assistant 占位、不修改流式状态；
 * - 带附件/超长文本不回退插入（附件无法随 inbox 文本投递），返回 false 保持既有队列语义；
 * - 投递失败（会话不存在、频率限制等）不打断进行中的回合，仅告警并返回 false。
 *
 * @returns true 表示已投递到主会话 inbox（由注入点在最近一次工具调用完成后带出）
 */
async function deliverInterruptMessage(
  state: ChatStoreState,
  messageText: string,
  attachments?: Attachment[]
): Promise<boolean> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return false
  if (attachments && attachments.length > 0) return false

  const text = messageText.trim()
  if (!text || text.length > INTERRUPT_MESSAGE_MAX_LENGTH) return false

  try {
    const result = await sendToExtension<{
      success: boolean
      error?: { code?: string; message?: string }
    }>('chat.sendInterruptMessage', {
      conversationId,
      text
    })
    if (result?.success) {
      // M3-1 ①：投递成功 -> 记录轻量回显（MessageList 消息区提示「已投递」）
      recordInterruptDelivery({ conversationId, text, kind: 'delivered' })
      return true
    }
    // M3-1 ③：投递被拒绝（如 INTERRUPT_MESSAGE_RATE_LIMITED）-> 可见反馈，
    // 不写 state.error，避免打断进行中的回合；返回 false 保持既有队列语义
    console.warn('[messageActions] chat.sendInterruptMessage rejected:', result)
    recordInterruptDelivery({
      conversationId,
      text,
      kind: 'error',
      errorCode: result?.error?.code,
      errorMessage: result?.error?.message
    })
    return false
  } catch (error) {
    console.warn('[messageActions] chat.sendInterruptMessage failed:', error)
    recordInterruptDelivery({
      conversationId,
      text,
      kind: 'error',
      errorCode: undefined,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return false
  }
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
        // M3-2：整数组替换后重建 message.id -> 下标 与 functionResponse.id -> 下标 索引
        rebuildMessageIndexById(state)
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
  // M3-2：与 appendMessage 对齐，增量维护 messageIndexById / toolResponseIndex
  appendMessage(state, responseMessage)
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

  // BR-01：本次发送窗口 user 消息的稳定节点 id（随 chatStream 传给后端原样落库）
  let pendingUserMessageId: string | undefined

  // U1（用户消息插入）：主会话正在工具循环/流式中时，不排队、不乐观插入窗口，
  // 把用户消息投递到主会话 inbox，由注入点在最近一次工具调用完成后带出，
  // 让主模型在工具循环中尽快感知用户输入。
  // 隐藏发送（计划确认等 functionResponse）与带附件消息不走插入路径，保持既有语义。
  if (!isHiddenSend && (state.isStreaming.value || state.isWaitingForResponse.value)) {
    return deliverInterruptMessage(state, messageText, attachments)
  }

  state.error.value = null
  state._pendingBranchReplayContext.value = null
  if (state.isWaitingForResponse.value) return false

  // 发送新消息 = 放弃上次失败的回答：回滚失败流保留的半截消息，
  // 避免窗口中出现后端不存在的幽灵消息。
  rollbackFailedStreamMessage(state)
  
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 记录请求发起时的对话 ID，用于 catch 块中的对话切换检测
  let originConvId: string | null = state.currentConversationId.value
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
        // BR-01：本地窗口近似父链（首条为 null）——用于编辑时根节点判断（parentId==null 降级 keep）；
        // 后端落库时 ensureNodeId 会生成准确 parentId，加载历史后以后端为准
        parentId: state.allMessages.value.length > 0
          ? (state.allMessages.value[state.allMessages.value.length - 1]?.id ?? null)
          : null,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        source: options?.source
      }
      // BR-01：记录窗口消息 id 并随 chatStream 传给后端原样落库，
      // 保证主历史 Content.id 与窗口消息 id 一致（编辑/重试/分支操作按 id 定位）
      pendingUserMessageId = userMessage.id
      state.allMessages.value.push(userMessage)
    }

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
    if (!validateSessionIdentity(state, targetConvId)) {
      // H5(a)：会话已切换：复位本次发送设置的流式状态，避免 isStreaming 等永久残留。
      // 仅当当前 streamingMessageId 仍是本次发送的占位时才复位，
      // 避免误清新会话自己正在进行的流。
      if (state.streamingMessageId.value === assistantMessageId) {
        resetPendingSendState(state)
      }
      return false
    }

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
      // BR-01：窗口 user 消息的稳定节点 id（后端原样落库，编辑/重试才能按 id 定位）
      messageId: pendingUserMessageId,
      attachments: hiddenFunctionResponse ? undefined : attachmentData,
      modelOverride: effectiveModelOverride,
      hiddenFunctionResponse,
      promptModeId: state.currentPromptModeId.value,
      dynamicContextStrategyOverride: options?.dynamicContextStrategyOverride,
      source: options?.source,
      streamId
    })

    // H5(b)：await 期间会话可能已切换（流会在后端继续、chunk 进入原会话的后台缓冲）。
    // 校验失败时停止后续流程并标记，避免在无 UI 状态下继续写状态。
    if (!validateSessionIdentity(state, targetConvId)) {
      console.warn('[messageActions] sendMessage: conversation switched while chatStream in flight; stream continues in background', {
        targetConvId,
        currentConversationId: state.currentConversationId.value
      })
      return false
    }

  } catch (err: any) {
    if (state.isStreaming.value) {
      safeSetError(state, originConvId, {
        code: err.code || 'SEND_ERROR',
        message: err.message || 'Failed to send message'
      })
      resetPendingSendState(state)
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
  state.allMessages.value.push(assistantMessage)
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
  state._pendingBranchReplayContext.value = null
  state.error.value = null
}

/**
 * 可重试错误码集合（H-3 + FIX-C-1）。
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
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // keep 模式（真·原地保存）重放：不创建占位（后端不重新生成，complete 仅复位状态）
  const isKeepReplay = context.kind === 'editBranch' && context.mode === 'keep'
  if (!isKeepReplay) {
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
    if (state.isStreaming.value) {
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
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 计算后端索引（在修改数组之前）
  const backendMessageIndex = calculateBackendIndex(state.allMessages.value, messageIndex, state.windowStartIndex.value)
  
  const targetMessage = state.allMessages.value[messageIndex]
  // 根节点（parentId 为 null/undefined）：无父节点可挂编辑候选（BranchGraph 单根模型），
  // branch 模式自动降级为 keep（真·原地保存）
  const effectiveMode = mode === 'branch' && targetMessage.parentId == null ? 'keep' : mode
  targetMessage.content = newMessage
  targetMessage.parts = [{ text: newMessage }]
  targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined

  if (effectiveMode === 'keep') {
    // 真·原地保存：只改写本条消息，后续消息 / 检查点 / 分支全部保留，
    // 不截断窗口、不创建占位（后端不重新生成，流结束仅复位状态）
  } else {
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
    state.allMessages.value.push(assistantMessage)
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
      // 根节点自动降级为 keep（见上方 effectiveMode 注释）
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
    if (state.isStreaming.value) {
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
      targetIndex: backendIndex,
      // 索引漂移校验：后端据 messageId 校验目标消息未被其他请求移动
      messageId: targetMessageId
    })

    // 再次校验归属
    if (state.currentConversationId.value !== originConvId) return

    if (response?.success) {
      state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
      clearCheckpointsFromIndex(state, backendIndex)
      setTotalMessagesFromWindow(state)
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
    }>('summarizeContext', {
      conversationId: originConversationId,
      configId: state.configId.value
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
    await sendToExtension('cancelSummarizeRequest', { conversationId })
  } catch (error) {
    console.error('[messageActions] Failed to cancel summarize request:', error)
  }
}