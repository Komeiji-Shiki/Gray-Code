/**
 * 消息发送主流程（从 messageActions.ts 拆出）。
 *
 * 包含 sendMessage 及其私有辅助（失败占位清理 / 流式状态复位 / 安全错误写入 /
 * 忙时投递 / 隐藏 functionResponse 等），以及跨模块共享的索引与模型覆盖工具
 * （calculateBackendIndex / getNextBackendIndex / resolveConversationModelOverride / safeSetError），
 * 供 retryFlows / deleteFlows / summaryFlows 单向导入（避免循环依赖）。
 *
 * 逻辑逐字迁移：流式竞态防护（isStaleCallback / 防重入 / 防跨会话）、动作边界投递、
 * P2 回执窗口、interrupt 限频等已修 bug 注释原样保留，一行未改。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { Message, Attachment } from '../../../types'
import type { ChatStoreState, ChatStoreComputed, AttachmentData, ErrorInfo } from '../types'
import { triggerRef } from 'vue'
import { sendToExtension } from '../../../utils/vscode'
import { generateId } from '../../../utils/format'
import { createAndPersistConversation, syncConversationWorkspaceUri } from '../conversationActions'
import { updateTabConversationId, updateTabTitle } from '../tabActions'
import { clearCheckpointsFromIndex } from '../checkpointActions'
import { persistConversationModelConfig, persistConversationPromptMode } from '../configActions'
import { validateSessionIdentity } from '../utils'
import { rebuildMessageIndexById, appendMessage, getMessageIndexById, replaceMessageAt } from '../state'
import { syncTotalMessagesFromWindow, setTotalMessagesFromWindow, trimWindowFromTop } from '../windowUtils'
import { recordInterruptDelivery, INTERRUPT_MESSAGE_MAX_LENGTH } from './interruptNotices'

/**
 * 发送失败清理：移除本次发送遗留的窗口占位（user 消息 + assistant 空气泡）。
 *
 * 仅当 assistant 占位仍为空（localOnly && 无 parts/content/tools）时移除两条：
 * 若流式已产出内容（半截回答），保留两者供错误条重试；隐藏发送（无 user 消息）只处理占位。
 */
function cleanupFailedSendPlaceholders(
  state: ChatStoreState,
  pendingUserMessageId: string | undefined,
  assistantMessageId: string | null
): void {
  if (!pendingUserMessageId && !assistantMessageId) return

  const all = state.allMessages.value
  const removeIds = new Set<string>()

  if (assistantMessageId) {
    const idx = getMessageIndexById(state, assistantMessageId)
    if (idx !== -1) {
      const msg = all[idx]
      const isEmptyPlaceholder = msg?.localOnly === true
        && !msg.content
        && !msg.tools
        && !msg.parts?.some(p => p.text || p.functionCall || p.inlineData || p.fileData)
      if (isEmptyPlaceholder) {
        removeIds.add(assistantMessageId)
      }
    }
  }

  // user 消息仅在空气泡仍为空（或本次未创建空气泡）时一并移除，
  // 避免误删用户已发送且已收到部分回答的消息
  if (pendingUserMessageId && (removeIds.has(assistantMessageId ?? '') || !assistantMessageId)) {
    removeIds.add(pendingUserMessageId)
  }

  if (removeIds.size === 0) return

  state.allMessages.value = all.filter(m => !removeIds.has(m.id))
  rebuildMessageIndexById(state)
  setTotalMessagesFromWindow(state)
}

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
  // 发送失败即完全复位：回合级覆盖（模型/渠道）不留残渣。
  // 注：仅「流转入后台对话继续」路径（validateSessionIdentity 二次校验失败）保留覆盖，
  // 由目标标签页快照恢复兜底，不经过本函数。
  state.pendingModelOverride.value = null
  state.pendingConfigIdOverride.value = null
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
export function safeSetError(
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
  /**
   * 一次性渠道覆盖：仅本次请求（及同一回合内的工具确认）使用该 configId，
   * 不写后端全局 activeChannelId、不写对话元数据。
   * 建议配套 modelOverride 一并传入，保证 assistant 消息 modelVersion 显示一致。
   */
  configIdOverride?: string
  hidden?: { functionResponse: HiddenFunctionResponsePayload }
  dynamicContextStrategyOverride?: 'single' | 'preserve'
  /** 消息来源；内部回流不会被当作真实用户新回合 */
  source?: 'user' | 'background_task' | 'agent_message'
  /** agent_message 领取凭据；后端在内部消息落库后确认消费。 */
  agentMessageClaimId?: string
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
    }>(MESSAGE_NAMES['chat.sendInterruptMessage'], {
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

export function getNextBackendIndex(state: ChatStoreState): number {
  return state.windowStartIndex.value + state.allMessages.value.length
}

export function resolveConversationModelOverride(
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
        // 走 replaceMessageAt 而非直写新数组：中间位置替换会自动清除 windowUtils 可见消息
        // 增量缓存（指纹只校验首尾元素，直写数组会把旧消息对象留在可见缓存里）并递增结构
        // 版本（todoSnapshot / usedTokens 增量缓存持有同一数组代理，逐元素比较恒真）；
        // 尾部替换为流式安全模式，不递增。同 id 替换不改变消息位置，索引无需重建。
        replaceMessageAt(state, i, { ...msg, parts: nextParts })
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

  // 本次发送的 assistant 占位 id（catch 清理用；声明在 try 外，避免 try 早期抛错时 TDZ）
  let assistantMessageId: string | null = null

  // U1（用户消息插入）：主会话正在工具循环/流式中时，不排队、不乐观插入窗口，
  // 把用户消息投递到主会话 inbox，由注入点在最近一次工具调用完成后带出，
  // 让主模型在工具循环中尽快感知用户输入。
  // 隐藏发送（计划确认等 functionResponse）与带附件消息不走插入路径，保持既有语义。
  if (!isHiddenSend && (state.isStreaming.value || state.isWaitingForResponse.value)) {
    return deliverInterruptMessage(state, messageText, attachments)
  }

  // hidden 发送流式守卫：主会话流仍在活跃输出（isStreaming 与 activeStreamId 同时成立）时，
  // 再发起一条新流会覆盖 activeStreamId，旧流后续 chunk 会被 streamHandler 按错流/迟到丢弃，
  // 两条流互相踩踏。审批门闸暂停态不受影响——chunkTools 门闸处理会把 isStreaming /
  // activeStreamId 置空（仅 isWaitingForResponse 可能保持 true），「等待态放行」语义保持不变。
  if (isHiddenSend && state.isStreaming.value && state.activeStreamId.value) {
    return false
  }

  state.error.value = null
  state._pendingBranchReplayContext.value = null
  // hidden 发送（计划确认等 functionResponse）在等待态下放行：它不走忙时投递分支，
  // 若在此被 isWaitingForResponse 拦截会静默返回 false 且无人消费，计划确认丢失。
  if (state.isWaitingForResponse.value && !isHiddenSend) return false

  // 发送新消息 = 放弃上次失败的回答：回滚失败流保留的半截消息，
  // 避免窗口中出现后端不存在的幽灵消息。
  rollbackFailedStreamMessage(state)
  
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true

  // 记录请求发起时的对话 ID，用于 catch 块中的对话切换检测
  let originConvId: string | null = state.currentConversationId.value
  const effectiveModelOverride = resolveConversationModelOverride(state, options?.modelOverride)
  // 一次性渠道覆盖：仅本次请求生效，不改全局 configId/后端设置
  const effectiveConfigId = (options?.configIdOverride || '').trim() || state.configId.value
  
  // 创建会话分支固化的 newId（创建期间用户可能切换标签页/会话，
  // currentConversationId 随后可能已被新会话接管，后续必须以 newId 为准）
  let createdConversationId: string | null = null

  try {
    if (!state.currentConversationId.value) {
      // await 前固化目标标签页：创建对话期间用户可能切换标签页，绑定必须基于快照
      const tabIdAtSend = state.activeTabId.value
      const newId = await createAndPersistConversation(state, messageText)
      if (!newId) {
        throw new Error('Failed to create conversation')
      }
      createdConversationId = newId
      originConvId = newId
      // 更新当前标签页的 conversationId 和标题（仅当用户没有切换走）
      if (tabIdAtSend && state.activeTabId.value === tabIdAtSend) {
        updateTabConversationId(state, tabIdAtSend, newId)
        const title = messageText.slice(0, 30) + (messageText.length > 30 ? '...' : '')
        updateTabTitle(state, tabIdAtSend, title)
      }

      await persistConversationModelConfig(state)
      await persistConversationPromptMode(state)
    }

    // 固化目标会话 ID：此后所有会话标识读写以此为准，避免多次 await 后重读 currentConversationId
    // （创建会话期间用户切换标签页后 currentConversationId 可能已是其他会话，
    // 创建分支必须使用固化的 newId，否则新消息会追加/发送到切换后的会话，新建 A 成孤儿）
    const targetConvId = createdConversationId ?? state.currentConversationId.value
    if (!targetConvId) {
      throw new Error('No conversation ID after creation')
    }

    // 追加/发送前校验会话归属：创建会话期间用户已切换标签页/会话时中止本次发送，
    // 避免把新消息追加到已切换会话的窗口并发送到错误会话（H5 同款：复位流式状态）
    if (createdConversationId && !validateSessionIdentity(state, createdConversationId)) {
      // 对齐 H5(a)（474-481 同款守卫）：仅当当前 streamingMessageId 仍是本次发送的占位时才复位。
      // 本分支尚未创建 assistant 占位（assistantMessageId 仍为 null），守卫等价于
      // 「当前会话没有进行中的流式消息」——切到的标签页若正在流式（快照恢复
      // isStreaming=true / streamingMessageId 非空）则不复位，避免误清新会话流式状态。
      if (state.streamingMessageId.value === assistantMessageId) {
        resetPendingSendState(state)
      }
      return false
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
      appendMessage(state, userMessage)
    }

    assistantMessageId = generateId()
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
    appendMessage(state, assistantMessage)
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
    // 一次性渠道覆盖随本回合生效：工具确认等后续请求沿用同一渠道
    state.pendingConfigIdOverride.value = (options?.configIdOverride || '').trim()
      ? effectiveConfigId
      : null
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

    const streamResult = await sendToExtension<{ success?: boolean }>(MESSAGE_NAMES.chatStream, {
      conversationId: targetConvId,
      configId: effectiveConfigId,
      message: messageText,
      // BR-01：窗口 user 消息的稳定节点 id（后端原样落库，编辑/重试才能按 id 定位）
      messageId: pendingUserMessageId,
      attachments: hiddenFunctionResponse ? undefined : attachmentData,
      modelOverride: effectiveModelOverride,
      hiddenFunctionResponse,
      promptModeId: state.currentPromptModeId.value,
      dynamicContextStrategyOverride: options?.dynamicContextStrategyOverride,
      source: options?.source,
      agentMessageClaimId: options?.agentMessageClaimId,
      streamId
    })
    // 发送被后端明确拒绝（渠道/参数校验失败等）：走 catch 同款清理（移除空气泡与 user 占位）
    if (streamResult?.success === false) {
      throw new Error('chatStream rejected by backend')
    }

    // H5(b)：await 期间会话可能已切换（流会在后端继续、chunk 进入原会话的后台缓冲）。
    // 校验失败时停止后续流程并标记，避免在无 UI 状态下继续写状态。
    if (!validateSessionIdentity(state, targetConvId)) {
      // 通常表示用户主动切到其他标签页：原流继续在已绑定标签页的后台缓冲中运行。
      // 若目标会话已经没有任何标签页承接（启动重置/标签页关闭竞态），终结 chunk 会被丢弃，
      // 此时必须回收仍属于本次占位的全局流式状态，否则空白页会永久停在等待态。
      const targetTabStillOpen = state.openTabs.value.some(tab => tab.conversationId === targetConvId)
      if (!targetTabStillOpen && state.streamingMessageId.value === assistantMessageId) {
        cleanupFailedSendPlaceholders(state, pendingUserMessageId, assistantMessageId)
        resetPendingSendState(state)
      }
      console.warn('[messageActions] sendMessage: conversation switched while chatStream in flight; stream continues in background', {
        targetConvId,
        currentConversationId: state.currentConversationId.value
      })
      return false
    }

  } catch (err: any) {
    // 独立于 isStreaming 判断是否取消：取消瞬间 isStreaming 已被 cancelStream 清除，
    // 若这里仍依赖 isStreaming，真实的发送失败会被当成"已取消"静默吞掉。
    // _lastCancelledStreamId 存的是被取消请求的 streamingMessageId（消息 id，见
    // toolActions.cancelStream 的写入与 types.ts 声明），与本次发送的占位消息 id
    // （assistantMessageId）比较才能命中「用户取消 + 迟到失败」场景；不能与
    // activeStreamId（streamId）比较——两者类型不同永不相等（原实现导致恒 false）。
    const wasStreamCancelled = state._lastCancelledStreamId.value === assistantMessageId
    if (!wasStreamCancelled) {
      safeSetError(state, originConvId, {
        code: err.code || 'SEND_ERROR',
        message: err.message || 'Failed to send message'
      })
    }
    // 发送失败清理：占位仍为空（localOnly && 无 parts/content/tools）时
    // 按本次 push 的 pendingUserMessageId + assistantMessageId 移除两条
    cleanupFailedSendPlaceholders(state, pendingUserMessageId, assistantMessageId)
    resetPendingSendState(state)
    return false
  } finally {
    state.isLoading.value = false
  }

  return true
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
  rebuildMessageIndexById(state)
  clearCheckpointsFromIndex(state, backendIndex)
  setTotalMessagesFromWindow(state)
  return backendIndex
}

