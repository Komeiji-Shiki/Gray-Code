/**
 * 流式 Chunk 处理器
 * 
 * 处理各种类型的 StreamChunk
 */

import type { Content, Message, StreamChunk, ToolUsage, ToolExecutionResult } from '../../types'
import type { ChatStoreState, CheckpointRecord } from './types'
import { tpsMeter } from '../../utils/tpsMeter'
import { pushSmoothText, finishSmoothStream, migrateSmoothStream } from './smoothStreamManager'
import { triggerRef } from 'vue'
import { generateId } from '../../utils/format'
import { contentToMessage, contentToMessageEnhanced } from './parsers'
import {
  addTextToMessage,
  processStreamingText,
  flushToolCallBuffer,
  handleFunctionCallPart
} from './streamHelpers'
import { syncTotalMessagesFromWindow, syncFoldedHistoryHint, trimWindowFromTop } from './windowUtils'
import { appendMessage, getMessageIndexById, insertMessageAt, removeMessageAt, replaceMessageAt } from './state'
import { getToolApprovalStopKind } from '../../utils/toolContinuations'
import { isPerfEnabled } from '../../utils/perf'

function getNextBackendIndex(state: ChatStoreState): number {
  return state.windowStartIndex.value + state.allMessages.value.length
}

/**
 * H4：无 streamId 的 error/cancelled chunk 降级归属判定。
 *
 * 后端部分终结事件（error/cancelled）不携带 streamId，此时 handleStreamChunk 的
 * streamId 过滤无法拦截它们。当“当前流存在活跃 streamId”（说明有更新的请求在跑）
 * 时，这类 chunk 无法证明属于当前流——它可能是旧请求的迟到回调。
 *
 * 判定规则（核心：旧流的迟到终结 chunk 不能删除/改写新请求创建的占位消息）：
 * - chunk 无 conversationId：无法归属 → 视为“未确认”迟到（调用方只记错误，不删消息）；
 * - chunk.conversationId 与当前会话不一致：迟到；
 * - 目标占位消息创建时间晚于 chunk.createdAt：chunk 属于更早的请求 → 迟到。
 *
 * 返回 true 表示该 chunk 应被当作迟到处理：不得触碰占位消息，也不得复位当前流状态。
 */
function isLateTerminalChunkWithoutStreamId(chunk: StreamChunk, state: ChatStoreState): boolean {
  if (chunk.streamId || !state.activeStreamId.value) return false
  if (!chunk.conversationId) return true
  if (chunk.conversationId !== state.currentConversationId.value) return true
  const targetIndex = getMessageIndexById(state, state.streamingMessageId.value)
  const targetMessage = targetIndex >= 0 ? state.allMessages.value[targetIndex] : undefined
  if (!targetMessage) return false
  return typeof chunk.createdAt === 'number' && chunk.createdAt < targetMessage.timestamp
}

/**
 * 把后端已持久化的 Content 投影为消息，并用稳定节点 ID 替换前端流式占位 ID。
 *
 * 旧后端没有回传 content.id 时保留占位 ID；新后端回传稳定 ID 时同步
 * streamingMessageId，保证后续工具状态/确认事件仍能定位到同一条消息。
 */
function contentToPersistedMessage(content: Content, currentMessage: Message, state: ChatStoreState): Message {
  const persistedId = typeof content.id === 'string' && content.id.trim()
    ? content.id
    : currentMessage.id
  const persistedMessage = contentToMessage(content, persistedId)

  if (persistedId !== currentMessage.id && state.streamingMessageId.value === currentMessage.id) {
    state.streamingMessageId.value = persistedId
    // H1：平滑显示层键随占位 id → 持久化 id 迁移，避免按新 id 终结清理时残留旧条目
    migrateSmoothStreamForState(state, currentMessage.id, persistedId)
  }
  return persistedMessage
}

/**
 * 合并工具列表：以 incoming（按 AI 输出顺序）为基准，尽量保留 existing 中的运行态字段。
 *
 * 目标：避免 toolsExecuting/awaitingConfirmation/toolIteration 阶段用 contentToMessage 生成的
 * "queued" 覆盖掉 toolStatus 写入的真实状态/结果。
 *
 * 匹配策略（按优先级）：id > index > itemId。
 * 当 id 不一致但 index/itemId 一致时（Anthropic 等渠道 id 延迟到达），仍能正确合并，
 * 避免流式过程中出现重复的工具调用框。
 */
function mergeToolsPreferExisting(
  existing: ToolUsage[] | undefined,
  incoming: ToolUsage[] | undefined
): ToolUsage[] | undefined {
  const a = existing || []
  const b = incoming || []
  if (a.length === 0) return b.length > 0 ? b : undefined
  if (b.length === 0) return a.length > 0 ? a : undefined

  // 构建多维度索引
  const byId = new Map<string, ToolUsage>()
  const byIndex = new Map<number, ToolUsage>()
  const byItemId = new Map<string, ToolUsage>()
  for (const t of a) {
    if (t && typeof t.id === 'string') byId.set(t.id, t)
    const idx = (t as any).index
    if (typeof idx === 'number') byIndex.set(idx, t)
    const iid = typeof (t as any).itemId === 'string' && (t as any).itemId.trim() ? (t as any).itemId.trim() : ''
    if (iid) byItemId.set(iid, t)
  }

  const consumed = new Set<ToolUsage>()
  const merged: ToolUsage[] = []

  for (const t of b) {
    // 1) 按 id 匹配
    let e = byId.get(t.id)
    // 2) 按 index 匹配（type number，包括 0）
    if (!e) {
      const idx = (t as any).index
      if (typeof idx === 'number') e = byIndex.get(idx)
    }
    // 3) 按 itemId 匹配
    if (!e) {
      const iid = typeof (t as any).itemId === 'string' && (t as any).itemId.trim() ? (t as any).itemId.trim() : ''
      if (iid) e = byItemId.get(iid)
    }

    if (!e) {
      merged.push(t)
      continue
    }

    consumed.add(e)

    const incomingHasArgs = !!(t.args && Object.keys(t.args).length > 0)
    const partialArgs = typeof t.partialArgs === 'string'
      ? (typeof e.partialArgs === 'string' && e.partialArgs.length > t.partialArgs.length ? e.partialArgs : t.partialArgs)
      : (incomingHasArgs ? undefined : e.partialArgs)

    let status = e.status ?? t.status
    if (!partialArgs && incomingHasArgs && status === 'streaming') {
      status = 'queued'
    }

    // incoming 提供更完整的 name/args/id；existing 提供更可信的 status/result/error/duration
    merged.push({
      ...e,
      ...t,
      status,
      result: e.result ?? t.result,
      error: e.error ?? t.error,
      duration: e.duration ?? t.duration,
      awaitingConfirmation: e.awaitingConfirmation ?? t.awaitingConfirmation,
      partialArgs
    })
  }

  // 兜底：只保留 existing 中未被任何 incoming 匹配到的工具
  for (const t of a) {
    if (!consumed.has(t)) {
      merged.push(t)
    }
  }

  return merged.length > 0 ? merged : undefined
}

function normalizeStreamingToQueued(status?: ToolUsage['status']): ToolUsage['status'] | undefined {
  return status === 'streaming' ? 'queued' : status
}

function buildMessageFromContentSnapshot(currentMessage: Message, snapshotContent: NonNullable<StreamChunk['chunk']>['contentSnapshot']): Message {
  const existingModelVersion = currentMessage.metadata?.modelVersion
  const snapshotMessage = contentToMessageEnhanced(snapshotContent!, currentMessage.id)
  let mergedTools = mergeToolsPreferExisting(currentMessage.tools, snapshotMessage.tools)

  const updatedMessage: Message = {
    ...currentMessage,
    ...snapshotMessage,
    id: currentMessage.id,
    timestamp: currentMessage.timestamp,
    backendIndex: currentMessage.backendIndex,
    localOnly: currentMessage.localOnly,
    streaming: currentMessage.streaming,
    // 三级 fallback：合并结果 > snapshot 提取的 tools > 已有的 tools
    // 确保 snapshot 重建不会因为 merge 结果为空而丢失工具信息
    tools: (mergedTools && mergedTools.length > 0)
      ? mergedTools
      : (snapshotMessage.tools && snapshotMessage.tools.length > 0 ? snapshotMessage.tools : currentMessage.tools)
  }

  if (!updatedMessage.metadata) {
    updatedMessage.metadata = {}
  }

  if (existingModelVersion) {
    updatedMessage.metadata.modelVersion = existingModelVersion
  }

  return updatedMessage
}

/**
 * 根据工具响应推断前端统一状态机（与 ToolMessage 的逻辑对齐）。
 */
function deriveToolStatusFromResult(result: Record<string, unknown>): ToolUsage['status'] {
  const r = result as any

  // 明确的失败/取消/拒绝优先
  if (r?.cancelled || r?.rejected) return 'error'
  if (r?.success === false) return 'error'
  if (typeof r?.error === 'string' && r.error.trim()) return 'error'

  const data = r?.data
  if (data && typeof data === 'object') {
    // diff 等工具可能返回 data.status=pending 表示等待用户应用/审阅
    if ((data as any).status === 'pending') return 'awaiting_apply'

    const appliedCount = (data as any).appliedCount
    const failedCount = (data as any).failedCount
    if (typeof appliedCount === 'number' && typeof failedCount === 'number' && appliedCount > 0 && failedCount > 0) {
      return 'warning'
    }
  }

  return 'success'
}

/**
 * 平滑流式：真实内容已累加（addTextToMessage / processStreamingText），
 * 这里把增量文本送入显示层蓄水池（SmoothStreamer）；TPS 等指标吃真实 chunk，不经此层。
 * 段落身份（thought/text + part 索引）变化时由 manager 自动重置蓄水池。
 */
function pushSmoothTextForMessage(message: Message, deltaText: string, state: ChatStoreState): void {
  // M1：档位经 state.smoothMode 传递（chatStore watch settingsStore 同步），
  // 不再每 chunk 内联 useSettingsStore()；测试 mock 状态缺字段时兜底 'off'。
  const mode = state.smoothMode?.value ?? 'off'
  if (!deltaText) return
  if (mode === 'off') {
    // H3 on→off：档位切回直通时立即放完积压并销毁实例，UI 切回真实 content
    finishSmoothStreamForState(state, message.id)
    return
  }
  // M5：非 streaming 消息不写平滑层（与 MessageItem 的 isStreaming 门控对齐）
  if (message.streaming !== true) return
  const parts = message.parts
  if (!parts || parts.length === 0) return
  const lastPart = parts[parts.length - 1]
  if (typeof lastPart.text !== 'string') return
  // H2-A：新段落前导空白（该 part 尚无可见文本）不推入显示层——flushText 因 trim 为空
  // 不会为其生成块，推入会让平滑文本覆盖上一段已完成块（消失→重现闪烁）。
  if (!lastPart.text.trim()) return
  const partKey = `${lastPart.thought === true ? 'thought' : 'text'}:${parts.length - 1}`
  // H3 off→on / 段落切换：显示基线 = 当前 part 已累计真实文本（不含本次 delta），
  // 首次 commit 时 displayText = baseText + delta，与已渲染真实内容连续、不跳变。
  const partText = lastPart.text
  const deltaLen = deltaText.length
  const baseText = deltaLen > 0 && deltaLen <= partText.length
    ? partText.slice(0, partText.length - deltaLen)
    : ''
  pushSmoothText(message.id, partKey, deltaText, mode, baseText, (partKeyAtCommit, displayText) => {
    // M3：commit 前比较旧值（partKey + text），未变化时跳过 set，避免每次 commit
    // 都触发整条消息 renderBlocks 全量重算。
    const prev = state.smoothTexts.get(message.id)
    if (!prev || prev.partKey !== partKeyAtCommit || prev.text !== displayText) {
      state.smoothTexts.set(message.id, { partKey: partKeyAtCommit, text: displayText })
    }
  })
}

/**
 * H1：平滑显示层条目随消息 id 迁移（占位 id → 后端持久化 id）。
 * manager entry 与 smoothTexts 键同步改名，终结清理按新 id 即可命中，不残留旧条目。
 */
function migrateSmoothStreamForState(state: ChatStoreState, fromId: string, toId: string): void {
  migrateSmoothStream(fromId, toId)
  const text = state.smoothTexts?.get(fromId)
  if (text !== undefined) {
    state.smoothTexts.delete(fromId)
    state.smoothTexts.set(toId, text)
  }
}

/**
 * 终结清理：放完积压（不丢尾巴）、销毁实例并删除显示文本，UI 切回真实 content。
 * 同时清理传入 id 与当前 streamingMessageId（cancelled 可能把占位 id 替换为后端持久化 id）。
 */
export function finishSmoothStreamForState(state: ChatStoreState, messageId?: string | null): void {
  const ids = new Set<string>()
  if (messageId) ids.add(messageId)
  if (state.streamingMessageId.value) ids.add(state.streamingMessageId.value)
  for (const id of ids) {
    finishSmoothStream(id)
    // smoothTexts 为本模块新增的显示层字段；测试 mock 状态可能不含它，缺失时跳过清理
    state.smoothTexts?.delete(id)
  }
}

/**
 * 清空状态中所有平滑条目（清空会话/重置/关闭标签页等本地重置路径用）：
 * 先放完当前流积压并销毁实例，再清空 smoothTexts，UI 立即切回真实 content。
 */
export function clearAllSmoothForState(state: ChatStoreState): void {
  finishSmoothStreamForState(state)
  for (const id of Array.from(state.smoothTexts?.keys() ?? [])) {
    finishSmoothStream(id)
    state.smoothTexts?.delete(id)
  }
}

/**
 * 处理 chunk 类型
 */
export function handleChunkType(chunk: StreamChunk, state: ChatStoreState): void {
  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  if (messageIndex === -1 || !chunk.chunk) {
    return
  }

  const snapshotContent = chunk.chunk.contentSnapshot
  if (snapshotContent) {
    const updatedMessage = buildMessageFromContentSnapshot(state.allMessages.value[messageIndex], snapshotContent)
    replaceMessageAt(state, messageIndex, updatedMessage)
  }

  const message = state.allMessages.value[messageIndex]
  if (chunk.chunk.delta) {
    // 初始化 parts（如果不存在）
    if (!message.parts) {
      message.parts = []
    }
    
    // 没有快照时，按增量追加；有快照时，以快照为准，跳过旧的本地文本猜测逻辑
    if (!snapshotContent) {
      for (const part of chunk.chunk.delta) {
        if (part.text) {
          // TPS 实时可视化：按文本长度粗估 token 到达（供应商无逐 chunk usage 时）
          tpsMeter.record(Math.ceil(part.text.length / 3))
          if (part.thought) {
            addTextToMessage(message, part.text, true)
          } else {
            processStreamingText(message, part.text, state)
          }
          // 平滑显示层：真实内容已累加，这里驱动打字节奏（关闭时直通，无副作用）
          pushSmoothTextForMessage(message, part.text, state)
        }

        // 处理工具调用（原生 function call format）
        if (part.functionCall) {
          handleFunctionCallPart(part, message)
        }
      }
    }
    
    // 更新 token 信息和计时信息
    if (!message.metadata) {
      message.metadata = {}
    }
    
    // 如果 chunk 包含 thinkingStartTime，更新 metadata（用于实时显示思考时间）
    if ((chunk.chunk as any).thinkingStartTime) {
      message.metadata.thinkingStartTime = (chunk.chunk as any).thinkingStartTime
    }
    
    // 如果是最后一个 chunk（done=true），更新 token 信息
    // 注意：modelVersion 保持创建时的值，不从 API 响应更新
    if (chunk.chunk.done) {
      // 兜底：AI 输出结束，所有 streaming 工具应已完成参数输出
      if (message.tools) {
        for (const tool of message.tools) {
          if (tool.status === 'streaming') {
            tool.status = 'queued'
            // 清理流式预览状态
            delete tool.partialArgs
            // 从 parts 同步最终 args
            const matchingPart = message.parts?.find(
              p => p.functionCall && p.functionCall.id === tool.id
            )
            if (matchingPart?.functionCall?.args) {
              tool.args = matchingPart.functionCall.args
            }
          }
        }
      }

      if (chunk.chunk.usage) {
        message.metadata.usageMetadata = chunk.chunk.usage
        message.metadata.thoughtsTokenCount = chunk.chunk.usage.thoughtsTokenCount
        message.metadata.candidatesTokenCount = chunk.chunk.usage.candidatesTokenCount
      }
    }
  }
}

/**
 * 处理 toolsExecuting 类型
 */
export function handleToolsExecuting(chunk: StreamChunk, state: ChatStoreState): void {
  // 工具即将开始执行（不需要确认的工具，或用户已确认的工具）
  // 在工具执行前先更新消息的计时信息，让前端立即显示

  // 重要：将 isStreaming 设为 true，这样用户点击取消时会发送取消请求到后端
  // 这解决了用户确认工具后点击取消不生效的问题
  state.isStreaming.value = true

  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)

  if (messageIndex !== -1 && chunk.content) {
    const message = state.allMessages.value[messageIndex]

    // 保存原有的 modelVersion 和 tools
    // 注意：必须保留原始 tools，因为 contentToMessage 会将工具状态设为 success
    const existingModelVersion = message.metadata?.modelVersion
    const existingTools = message.tools

    const finalMessage = contentToPersistedMessage(chunk.content, message, state)

    // 诊断日志（仅性能诊断开关开启时输出：每次终结 batch 都会执行，热路径下无谓拼接）
    const fcCount = finalMessage.parts?.filter(p => p.functionCall).length ?? 0
    if (isPerfEnabled()) {
      console.debug(`[handleToolsExecuting] msgId=${message.id} existingTools=${existingTools?.length ?? 0} contentTools=${finalMessage.tools?.length ?? 0} fcParts=${fcCount}`)
    }

    // 合并 tools：以 finalMessage.tools 的顺序为基准，保留 existingTools 的运行态字段
    const mergedTools = mergeToolsPreferExisting(existingTools, finalMessage.tools) || []

    // 创建更新后的消息对象
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      timestamp: message.timestamp || finalMessage.timestamp,
      streaming: false,
      // toolsExecuting 阶段的 content 已写入后端历史（模型消息已持久化）
      localOnly: false,
      // 优先使用合并结果，其次回退到已有 tools，避免 batch 跳过 chunk 导致 tools 丢失
      tools: mergedTools.length > 0 ? mergedTools : (existingTools || undefined)
    }

    // 恢复原有的 modelVersion，同时保留后端返回的计时信息
    if (updatedMessage.metadata) {
      if (existingModelVersion) {
        updatedMessage.metadata.modelVersion = existingModelVersion
      }
      delete updatedMessage.metadata.thinkingStartTime
    }

    // 标记工具为 executing/queued 状态（后一个工具必须等待前一个完成，因此同一批次只把队首标为 executing）
    if (updatedMessage.tools) {
      const pending = (chunk.pendingToolCalls || []) as Array<{ id: string }>
      const executingId = pending[0]?.id
      const queuedIds = new Set(pending.slice(1).map(t => t.id))

      updatedMessage.tools = updatedMessage.tools.map(tool => {
        // AI 输出完成后，工具如果还停留在 streaming，则进入 queued，并清理 partialArgs
        const isStreaming = tool.status === 'streaming'
        const baseStatus = isStreaming ? 'queued' : tool.status
        const baseTool = isStreaming ? { ...tool, partialArgs: undefined } : tool

        if (executingId && tool.id === executingId) {
          return { ...baseTool, status: 'executing' as const }
        }
        if (queuedIds.has(tool.id)) {
          return { ...baseTool, status: 'queued' as const }
        }
        return { ...baseTool, status: baseStatus as any }
      })
    }

    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    replaceMessageAt(state, messageIndex, updatedMessage)
    // H1：toolsExecuting 阶段消息已置 streaming=false，正文输出结束（后续为工具执行）。
    // 平滑显示层在此终结：放完积压、销毁实例并删除显示文本，UI 立即切回真实 content。
    // 正常流随后有 toolIteration/complete 兜底清理，此处覆盖「toolsExecuting 后无终结
    // 事件（异常终止 / 会话重置）」的泄漏路径；工具返回后若模型续写正文，pushSmoothText
    // 会以当前 part 真实文本为基线重建实例（与段落切换语义一致，不丢不闪）。
    finishSmoothStreamForState(state, message.id)
  }
  // 注意：不改变 streaming 状态，工具还在执行中
}

/**
 * 处理 toolStatus 类型（用于实时排队推进）
 */
export function handleToolStatus(chunk: StreamChunk, state: ChatStoreState): void {
  if (!chunk.toolStatus || !chunk.tool) return

  const toolUpdate = chunk.tool
  const all = state.allMessages.value

  // 1) 优先更新当前 streamingMessageId 对应的消息（通常就是包含工具调用的 assistant 消息）
  let messageIndex = -1
  if (state.streamingMessageId.value) {
    const idx = getMessageIndexById(state, state.streamingMessageId.value)
    if (idx !== -1) {
      const m = all[idx]
      if (m.role === 'assistant' && m.tools?.some(t => t.id === toolUpdate.id)) {
        messageIndex = idx
      }
    }
  }

  // 2) fallback：从后往前找最近一条包含该 toolId 的 assistant 消息
  if (messageIndex === -1) {
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i]
      if (m.role === 'assistant' && m.tools?.some(t => t.id === toolUpdate.id)) {
        messageIndex = i
        break
      }
    }
  }

  if (messageIndex === -1) return

  const message = all[messageIndex]
  const updatedTools = message.tools?.map(t => {
    if (t.id !== toolUpdate.id) return t

    return {
      ...t,
      status: toolUpdate.status as any,
      // 允许后端在 end 事件里携带结果，让前端即时展示（不影响历史索引）
      result: (toolUpdate.result as any) ?? t.result
    }
  })

  const updatedMessage: Message = {
    ...message,
    tools: updatedTools
  }

  replaceMessageAt(state, messageIndex, updatedMessage)
}

/**
 * 批量处理多个 toolStatus 更新（性能优化）。
 * 将多个 toolStatus chunk 的更新合并后只替换一次 allMessages，
 * 避免 N 次数组展开复制和 N 次 Vue 响应式通知。
 */
export function handleToolStatusBatch(chunks: StreamChunk[], state: ChatStoreState): void {
  if (chunks.length === 0) return

  // 收集所有 tool 更新，按目标消息分组
  interface ToolUpdate { status: any; result: any; args?: Record<string, unknown> }
  const updatesByMessageIndex = new Map<number, Map<string, ToolUpdate>>()
  const all = state.allMessages.value

  for (const chunk of chunks) {
    if (!chunk.toolStatus || !chunk.tool) continue
    const toolUpdate = chunk.tool

    // 查找目标消息
    let messageIndex = -1
    if (state.streamingMessageId.value) {
      const idx = getMessageIndexById(state, state.streamingMessageId.value)
      if (idx !== -1) {
        const m = all[idx]
        if (m.role === 'assistant' && m.tools?.some(t => t.id === toolUpdate.id)) {
          messageIndex = idx
        }
      }
    }
    if (messageIndex === -1) {
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i]
        if (m.role === 'assistant' && m.tools?.some(t => t.id === toolUpdate.id)) {
          messageIndex = i
          break
        }
      }
    }
    if (messageIndex === -1) continue

    if (!updatesByMessageIndex.has(messageIndex)) {
      updatesByMessageIndex.set(messageIndex, new Map())
    }
    updatesByMessageIndex.get(messageIndex)!.set(toolUpdate.id, {
      status: toolUpdate.status,
      result: toolUpdate.result,
      args: toolUpdate.args && typeof toolUpdate.args === 'object' ? toolUpdate.args as Record<string, unknown> : undefined
    })
  }

  if (updatesByMessageIndex.size === 0) return

  for (const [msgIdx, toolUpdates] of updatesByMessageIndex) {
    const message = state.allMessages.value[msgIdx]
    if (!message) continue
    const updatedTools = message.tools?.map(t => {
      const update = toolUpdates.get(t.id)
      if (!update) return t
      const hasArgsSnapshot = !!update.args
      return {
        ...t,
        status: update.status as any,
        ...(hasArgsSnapshot ? { args: update.args, partialArgs: undefined } : {}),
        result: (update.result as any) ?? t.result
      }
    })
    replaceMessageAt(state, msgIdx, { ...message, tools: updatedTools })
  }
}

/**
 * 处理 awaitingConfirmation 类型
 */
export function handleAwaitingConfirmation(
  chunk: StreamChunk,
  state: ChatStoreState,
  addCheckpoint: (checkpoint: CheckpointRecord) => void
): void {
  // 等待用户确认工具执行
  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  if (messageIndex !== -1 && chunk.content) {
    const message = state.allMessages.value[messageIndex]
    // 保存原有的 modelVersion
    const existingModelVersion = message.metadata?.modelVersion
    const existingTools = message.tools

    const finalMessage = contentToPersistedMessage(chunk.content, message, state)

    // 合并 tools：以 finalMessage.tools 的顺序为基准，保留 existingTools 的运行态字段
    const mergedTools = mergeToolsPreferExisting(existingTools, finalMessage.tools) || []

    // 创建更新后的消息对象
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      timestamp: message.timestamp || finalMessage.timestamp,
      streaming: false,
      // awaitingConfirmation 阶段的 content 已写入后端历史（模型消息已持久化）
      localOnly: false,
      tools: mergedTools.length > 0 ? mergedTools : undefined
    }

    // 恢复原有的 modelVersion，同时保留后端返回的计时信息
    if (updatedMessage.metadata) {
      // 恢复原有的 modelVersion
      if (existingModelVersion) {
        updatedMessage.metadata.modelVersion = existingModelVersion
      }
      // 确保计时信息从 chunk.content 正确传递
      // contentToMessage 已经从 chunk.content 提取了这些信息
      // 但如果原消息有 thinkingStartTime，需要清除（因为思考已完成）
      delete updatedMessage.metadata.thinkingStartTime
    }

    // 标记工具为等待确认状态，并同步已自动执行的工具结果（autoPrefix）
    if (updatedMessage.tools) {
      const pendingIds = new Set((chunk.pendingToolCalls || []).map((t: any) => t.id))
      const toolResults = chunk.toolResults || []
      const toolResultMap = new Map<string, ToolExecutionResult>()
      for (const tr of toolResults) {
        if (tr && typeof tr.id === 'string') {
          toolResultMap.set(tr.id, tr)
        }
      }

      // 使用 map 创建新数组
      updatedMessage.tools = updatedMessage.tools.map(tool => {
        // AI 输出完成后，工具如果还停留在 streaming，则进入 queued，并清理 partialArgs
        const isStreaming = tool.status === 'streaming'
        const baseStatus = (isStreaming ? 'queued' : tool.status) || 'queued'
        const baseTool = isStreaming ? { ...tool, partialArgs: undefined } : tool

        if (pendingIds.has(tool.id)) {
          // 轮到该工具，等待用户批准
          return { ...baseTool, status: 'awaiting_approval' as const }
        }
        
        // 如果有自动执行的结果，写回 result，并推断最终状态（success/error/warning/awaiting_apply）
        const tr = toolResultMap.get(tool.id)
        if (tr) {
          const result = tr.result as Record<string, unknown>
          const status = deriveToolStatusFromResult(result)
          const errFromResult =
            typeof (result as any)?.error === 'string' && (result as any).error.trim()
              ? String((result as any).error)
              : undefined
          return { ...baseTool, status, result, error: tool.error ?? errFromResult }
        }
        
        return { ...baseTool, status: baseStatus as any }
      })
    }

    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    replaceMessageAt(state, messageIndex, updatedMessage)
  }

  // 将 toolResults 也同步为一个隐藏的 functionResponse 消息（保持与 toolIteration 行为一致），
  // 这样 getToolResponseById / hasToolResponse 等逻辑可以正常工作。
  if (chunk.toolResults && chunk.toolResults.length > 0) {
    const existingResponseIds = new Set<string>()
    for (const m of state.allMessages.value) {
      if (m.isFunctionResponse && m.parts) {
        for (const p of m.parts) {
          if (p.functionResponse?.id) {
            existingResponseIds.add(p.functionResponse.id)
          }
        }
      }
    }

    const newParts = chunk.toolResults
      .filter(r => r.id && !existingResponseIds.has(r.id))
      .map(r => ({
        functionResponse: {
          name: r.name,
          response: r.result,
          id: r.id
        }
      }))

    if (newParts.length > 0) {
      const responseMessage: Message = {
        id: generateId(),
        role: 'user',
        content: '',
        timestamp: Date.now(),
        backendIndex: getNextBackendIndex(state),
        isFunctionResponse: true,
        parts: newParts
      }
      appendMessage(state, responseMessage)
      syncTotalMessagesFromWindow(state)
      trimWindowFromTop(state)

      // 同步填充工具响应缓存，加速后续 getToolResponseById 查询
      for (const p of newParts) {
        if (p.functionResponse.id && p.functionResponse.response) {
          state.toolResponseCache.value.set(
            p.functionResponse.id,
            p.functionResponse.response as Record<string, unknown>
          )
        }
      }
      // 手动触发 ref 更新，因为 Map.set() 不会被 Vue 的 ref 追踪
      triggerRef(state.toolResponseCache)
    }
  }

  // 处理可能包含的检查点
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }

  // 注意：不结束 streaming 状态的等待标志，因为需要等用户确认
  // 但 isStreaming 设为 false 允许用户操作
  state.isStreaming.value = false
  state.activeStreamId.value = null
  state._lastApprovalGatedStreamId.value = null
  // isWaitingForResponse 保持 true 或设为特殊状态
}

/**
 * 处理 toolIteration 类型
 */
export function handleToolIteration(
  chunk: StreamChunk,
  state: ChatStoreState,
  currentModelName: () => string,
  addCheckpoint: (checkpoint: CheckpointRecord) => void
): void {
  // 工具迭代完成：当前消息包含工具调用
  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  // H1：终结清理所需的占位 id——contentToPersistedMessage 可能迁移 streamingMessageId；
  // manager entry / smoothTexts 键按占位 id（迁移前）清理，避免残留。
  const placeholderId = state.streamingMessageId.value
  
  // 检查是否有工具被取消或拒绝
  const cancelledToolIds = new Set<string>()
  const toolResultMap = new Map<string, ToolExecutionResult>()
  if (chunk.toolResults) {
    for (const r of chunk.toolResults) {
      if (r && typeof r.id === 'string') {
        toolResultMap.set(r.id, r)
      }
      if ((r.result as any)?.cancelled && r.id) {
        cancelledToolIds.add(r.id)
      }
    }
  }
  const hasCancelledTools = cancelledToolIds.size > 0

  // 检查是否有工具要求暂停循环（如 create_plan 要求用户确认执行）
  const hasUserConfirmation = chunk.toolResults?.some(
    r => (r.result as any)?.requiresUserConfirmation
  ) ?? false

  let restoredTools: ToolUsage[] | undefined

  if (messageIndex !== -1) {
    const message = state.allMessages.value[messageIndex]
    // 保存原有的 tools 信息和 modelVersion
    const existingTools = message.tools
    const existingModelVersion = message.metadata?.modelVersion
    
    const finalMessage = contentToPersistedMessage(chunk.content!, message, state)
    
    // 诊断日志（仅性能诊断开关开启时输出）
    const fcCount = finalMessage.parts?.filter(p => p.functionCall).length ?? 0
    if (isPerfEnabled()) {
      console.debug(`[handleToolIteration] msgId=${message.id} existingTools=${existingTools?.length ?? 0} contentTools=${finalMessage.tools?.length ?? 0} fcParts=${fcCount}`)
    }

    // 恢复原有的 modelVersion，同时保留后端返回的计时信息
    if (finalMessage.metadata) {
      if (existingModelVersion) {
        finalMessage.metadata.modelVersion = existingModelVersion
      }
      // 清除 thinkingStartTime（因为思考已完成，后端已返回 thinkingDuration）
      delete finalMessage.metadata.thinkingStartTime
    }
    
    // 合并 tools：以 finalMessage.tools 顺序为基准，保留 existingTools 的运行态字段
    restoredTools = mergeToolsPreferExisting(existingTools, finalMessage.tools)
    if (!restoredTools || restoredTools.length === 0) {
      restoredTools = existingTools
    }

    // 依据 toolResults 写回 result，并推断最终状态（避免默认全 success 覆盖失败/警告/awaiting_apply）
    if (restoredTools && restoredTools.length > 0) {
      restoredTools = restoredTools.map(tool => {
        const tr = toolResultMap.get(tool.id)
        if (tr) {
          const result = tr.result as Record<string, unknown>
          const status = deriveToolStatusFromResult(result)
          const errFromResult =
            typeof (result as any)?.error === 'string' && (result as any).error.trim()
              ? String((result as any).error)
              : undefined
          return { ...tool, status, result, error: tool.error ?? errFromResult }
        }
        // 极端兜底：无 toolResult 时，仅归一 streaming→queued，避免卡死在 streaming
        const baseStatus = normalizeStreamingToQueued(tool.status)
        return { ...tool, status: baseStatus as any }
      })
    }
    
    // 创建更新后的消息对象（确保 Vue 响应式更新）
    // 保护 parts：如果 finalMessage.parts 缺少 functionCall 但 restoredTools 存在，
    // 保留原始 parts 以确保渲染工具块
    const safePartsForToolIteration = (restoredTools && restoredTools.length > 0 &&
      finalMessage.parts && !finalMessage.parts.some(p => p.functionCall))
      ? message.parts
      : finalMessage.parts
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      timestamp: message.timestamp || finalMessage.timestamp,
      streaming: false,
      // toolIteration 阶段的 content 已写入后端历史（模型消息已持久化）
      localOnly: false,
      tools: restoredTools,
      parts: safePartsForToolIteration
    }
    
    // 用新对象替换数组中的旧对象
    replaceMessageAt(state, messageIndex, updatedMessage)
  }
  
  // 添加 functionResponse 消息（标记为隐藏）
  // 注意：在“自动执行 + 等待批准”混合场景下，部分 toolResults 可能已在 awaitingConfirmation 阶段被同步过。
  // 这里做一次去重，避免重复插入。
  if (chunk.toolResults && chunk.toolResults.length > 0) {
    const existingResponseIds = new Set<string>()
    for (const m of state.allMessages.value) {
      if (m.isFunctionResponse && m.parts) {
        for (const p of m.parts) {
          if (p.functionResponse?.id) {
            existingResponseIds.add(p.functionResponse.id)
          }
        }
      }
    }

    const parts = chunk.toolResults
      .filter(r => r.id && !existingResponseIds.has(r.id))
      .map(r => ({
        functionResponse: {
          name: r.name,
          response: r.result,
          id: r.id
        }
      }))

    if (parts.length > 0) {
      const responseMessage: Message = {
        id: generateId(),
        role: 'user',
        content: '',
        timestamp: Date.now(),
        backendIndex: getNextBackendIndex(state),
        isFunctionResponse: true,
        parts
      }
      appendMessage(state, responseMessage)
      syncTotalMessagesFromWindow(state)
      trimWindowFromTop(state)

      // 同步填充工具响应缓存
      for (const p of parts) {
        if (p.functionResponse.id && p.functionResponse.response) {
          state.toolResponseCache.value.set(
            p.functionResponse.id,
            p.functionResponse.response as Record<string, unknown>
          )
        }
      }
      // 手动触发 ref 更新，因为 Map.set() 不会被 Vue 的 ref 追踪
      triggerRef(state.toolResponseCache)
    }
  }
  
  // 处理新创建的检查点
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }
  
  const toolArgsById = new Map<string, Record<string, unknown>>()
  for (const tool of restoredTools || []) {
    const args = tool.args && typeof tool.args === 'object'
      ? tool.args as Record<string, unknown>
      : {}
    toolArgsById.set(tool.id, args)
  }

  const hasApprovalStop = chunk.toolResults?.some(result => {
    const args = typeof result.id === 'string'
      ? toolArgsById.get(result.id)
      : undefined
    return getToolApprovalStopKind(result.name, result.result, args) !== null
  }) ?? false

  // 如果有工具被取消 或 有工具要求用户确认后再继续，结束 streaming 状态
  // requiresUserConfirmation: 工具执行后的门闸（如 create_plan）
  // hasApprovalStop: 覆盖 review -> plan 这类不依赖 requiresUserConfirmation 的宿主审批停止
  if (hasCancelledTools || hasUserConfirmation || hasApprovalStop) {
    // H1：终结性 toolIteration（工具被取消/审批门闸，后端不再发 complete）：
    // 必须在 streamingMessageId 置 null 之前清理平滑显示层（置空后 ids 为空会 no-op）
    finishSmoothStreamForState(state, placeholderId)
    state.streamingMessageId.value = null
    state.activeStreamId.value = null
    state.isStreaming.value = false
    state.isWaitingForResponse.value = false
    state._lastApprovalGatedStreamId.value = hasApprovalStop && chunk.streamId
      ? chunk.streamId
      : null
    return
  }

  state._lastApprovalGatedStreamId.value = null

  // H1：流继续（下一轮工具循环）——上一段工具调用消息已终结：放完其积压并清理显示文本；
  // 新占位消息的后续 delta 会创建新条目。
  finishSmoothStreamForState(state, placeholderId)
  
  // 创建新的占位消息用于接收后续 AI 响应
  const newAssistantMessageId = generateId()
  const newAssistantMessage: Message = {
    id: newAssistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    backendIndex: getNextBackendIndex(state),
    streaming: true,
    localOnly: true,
    metadata: {
      modelVersion: state.pendingModelOverride.value || currentModelName()
    }
  }
  appendMessage(state, newAssistantMessage)
  syncTotalMessagesFromWindow(state)
  trimWindowFromTop(state)
  state.streamingMessageId.value = newAssistantMessageId
  
  // 确保状态正确设置，这样用户可以在后续 AI 响应期间点击取消按钮
  // 这对于非流式模式尤为重要，因为工具执行完毕后会自动发起新的 AI 请求
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
}

/**
 * 处理 complete 类型
 */
export function handleComplete(
  chunk: StreamChunk,
  state: ChatStoreState,
  addCheckpoint: (checkpoint: CheckpointRecord) => void,
  updateConversationAfterMessage: () => Promise<void>
): void {
  // H4 同款守卫：无 streamId 的迟到 complete（审批门闸重启/后台缓冲等场景，旧流已退、
  // 新流已开始）会覆盖新流刚创建的占位消息并复位 activeStreamId，之后新流所有 chunk
  // 被 streamId 过滤丢弃——新回答永久丢失、界面显示旧内容。与 cancelled/error 同一防御层级。
  if (isLateTerminalChunkWithoutStreamId(chunk, state)) {
    console.warn('[streamChunkHandlers] Late complete chunk without streamId ignored (new stream active)', {
      conversationId: chunk.conversationId,
      createdAt: chunk.createdAt,
      streamingMessageId: state.streamingMessageId.value,
      activeStreamId: state.activeStreamId.value
    })
    return
  }

  // 竞态检测：如果 cancelStream 已清理旧请求，而新请求已开始，
  // 迟到的旧请求 complete chunk 不应该影响新请求的消息和状态
  const lastCancelledId = state._lastCancelledStreamId.value
  const isStaleCallback = !chunk.streamId && !!(
    lastCancelledId &&
    state.streamingMessageId.value &&
    state.streamingMessageId.value !== lastCancelledId
  )

  if (isStaleCallback) {
    state._lastCancelledStreamId.value = null
    return
  }

  // H1：终结清理所需的占位 id——contentToPersistedMessage 可能把它迁移为后端持久化 id，
  // manager entry / smoothTexts 键须按占位 id（迁移前）清理，否则按新 id 清理会残留。
  const streamMessageIdAtStart = state.streamingMessageId.value

  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  if (messageIndex !== -1) {
    const message = state.allMessages.value[messageIndex]
    // 保存原有的 tools 信息（complete 阶段的 content 通常只含文本，不含 functionCall）
    const existingTools = message.tools
    // 刷新工具调用缓冲区
    flushToolCallBuffer(message, state)
    // 保存原有的 modelVersion（使用创建时的模型，不从 API 响应更新）
    const existingModelVersion = message.metadata?.modelVersion
    
    const finalMessage = contentToPersistedMessage(chunk.content!, message, state)
    
    // 诊断日志（仅性能诊断开关开启时输出）
    const fcCountComplete = finalMessage.parts?.filter(p => p.functionCall).length ?? 0
    if (isPerfEnabled()) {
      console.debug(`[handleComplete] msgId=${message.id} existingTools=${existingTools?.length ?? 0} contentTools=${finalMessage.tools?.length ?? 0} fcParts=${fcCountComplete}`)
    }

    // 恢复原有的 modelVersion
    if (existingModelVersion && finalMessage.metadata) {
      finalMessage.metadata.modelVersion = existingModelVersion
    }
    
    // 创建更新后的消息对象
    // 保护 parts：如果 finalMessage.parts 不含 functionCall 但旧消息有 tools，
    // 说明 complete 的 content 可能来自后续迭代（只有文本），不应覆盖工具调用的 parts
    const safePartsForComplete = (existingTools && existingTools.length > 0 &&
      finalMessage.parts && !finalMessage.parts.some(p => p.functionCall))
      ? message.parts
      : finalMessage.parts
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      timestamp: message.timestamp || finalMessage.timestamp,
      streaming: false,
      // complete 代表后端已持久化该模型消息
      localOnly: false,
      // 保留已有的 tools（finalMessage.tools 通常为 undefined，会覆盖已积累的工具信息）
      tools: finalMessage.tools && finalMessage.tools.length > 0
        ? finalMessage.tools
        : existingTools,
      parts: safePartsForComplete
    }
    
    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    replaceMessageAt(state, messageIndex, updatedMessage)
  }
  
  // 处理新创建的检查点
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }
  
  // 平滑流式：放完积压并清理显示文本（真实 content 已由 complete 替换）
  // 传占位 id：即使 streamingMessageId 已被迁移为持久化 id，也能命中迁移前的 manager entry
  finishSmoothStreamForState(state, streamMessageIdAtStart)
  
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false  // 结束等待
  state.autoSummaryStatus.value = null
  state.pendingModelOverride.value = null
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
  
  // 流式完成后更新对话元数据
  updateConversationAfterMessage()
}

/**
 * 处理 checkpoints 类型
 */
export function handleCheckpoints(
  chunk: StreamChunk,
  addCheckpoint: (checkpoint: CheckpointRecord) => void
): void {
  // 立即收到的检查点（用户消息前后、模型消息前）
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }
}

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
 * 自动总结是在后端历史中直接 insertContent 的，
 * 前端需要同步插入一条总结消息，避免必须重载历史才能看到。
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

  // 去重：避免重复插入同一个 summary
  const exists = state.allMessages.value.some(
    m => m.isSummary && typeof m.backendIndex === 'number' && m.backendIndex === insertIndex
  )
  if (exists) {
    return
  }

  // 如果插入位置在当前窗口之前，仅维护索引偏移即可
  if (insertIndex < state.windowStartIndex.value) {
    state.windowStartIndex.value += 1
    for (const msg of state.allMessages.value) {
      if (typeof msg.backendIndex === 'number') {
        msg.backendIndex += 1
      }
    }
    syncTotalMessagesFromWindow(state)
    // 窗口前插入会顶掉一条可见消息：同步折叠提示，否则 foldedMessageCount 虚高
    syncFoldedHistoryHint(state)
    return
  }

  // 先将当前窗口中插入点及之后的 backendIndex 后移 1
  for (const msg of state.allMessages.value) {
    if (typeof msg.backendIndex === 'number' && msg.backendIndex >= insertIndex) {
      msg.backendIndex += 1
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

/**
 * 处理 cancelled 类型
 */
export function handleCancelled(chunk: StreamChunk, state: ChatStoreState): void {
  // H4：无 streamId 的迟到 cancelled chunk：不删除/改写新请求的占位消息，也不复位当前流状态
  if (isLateTerminalChunkWithoutStreamId(chunk, state)) {
    console.warn('[streamChunkHandlers] Late cancelled chunk without streamId ignored (new stream active)', {
      conversationId: chunk.conversationId,
      createdAt: chunk.createdAt,
      streamingMessageId: state.streamingMessageId.value,
      activeStreamId: state.activeStreamId.value
    })
    return
  }

  // 竞态检测：判断这个 cancelled chunk 是否属于已被 cancelStream() 清理过的旧请求。
  // 如果 cancelStream() 已经清理了状态并且新请求已经开始（streamingMessageId 已变为新 ID），
  // 此时迟到的 cancelled chunk 不应该重置新请求的全局状态。
  const lastCancelledId = state._lastCancelledStreamId.value
  const isStaleCallback = !chunk.streamId && !!(
    lastCancelledId &&
    state.streamingMessageId.value &&
    state.streamingMessageId.value !== lastCancelledId
  )

  if (isStaleCallback) {
    // 迟到的旧请求 cancelled chunk：只尝试清理旧消息的元数据，不重置全局状态
    const oldMsgIndex = getMessageIndexById(state, lastCancelledId)
    if (oldMsgIndex !== -1) {
      const msg = state.allMessages.value[oldMsgIndex]
      if (msg.streaming) {
        replaceMessageAt(state, oldMsgIndex, { ...msg, streaming: false })
      }
    }
    state._lastCancelledStreamId.value = null
    return
  }

  // H1：终结清理所需的占位 id——下方 persistedId 分支可能把 streamingMessageId 迁移为
  // 后端持久化 id；manager entry / smoothTexts 键按占位 id（迁移前）清理，避免残留。
  const streamMessageIdAtStart = state.streamingMessageId.value

  // 正常的 cancelled 处理
  let messageIndex = -1
  if (state.streamingMessageId.value) {
    messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  } else {
    // 兼容性处理：如果 streamingMessageId 已被 cancelStream 清除，则寻找最后一条助手消息
    // 仅当最后一条助手消息处于非流式状态（说明刚被 cancelStream 处理过）时才尝试更新其元数据
    const lastMsgIndex = state.allMessages.value.length - 1
    const lastMsg = state.allMessages.value[lastMsgIndex]
    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.streaming) {
      messageIndex = lastMsgIndex
    }
  }

  if (messageIndex !== -1) {
    const message = state.allMessages.value[messageIndex]
    
    // 如果消息为空且没有工具调用，删除它
    // 注意：思考内容只存在于 parts 中，不在 content 中，需要检查 parts
    const hasPartsContent = message.parts && message.parts.some(p => p.text || p.functionCall)
    if (!message.content && !message.tools && !hasPartsContent) {
      removeMessageAt(state, messageIndex)
    } else {
      // 构建新的 metadata 对象
      const newMetadata = message.metadata ? { ...message.metadata } : {}
      
      // 从后端返回的 content 中提取计时信息（后端在取消时也会保存计时信息）
      if (chunk.content) {
        if (chunk.content.thinkingDuration !== undefined) {
          newMetadata.thinkingDuration = chunk.content.thinkingDuration
        }
        if (chunk.content.responseDuration !== undefined) {
          newMetadata.responseDuration = chunk.content.responseDuration
        }
        if (chunk.content.streamDuration !== undefined) {
          newMetadata.streamDuration = chunk.content.streamDuration
        }
        if (chunk.content.firstChunkTime !== undefined) {
          newMetadata.firstChunkTime = chunk.content.firstChunkTime
        }
        if (chunk.content.chunkCount !== undefined) {
          newMetadata.chunkCount = chunk.content.chunkCount
        }
      }
      
      // 更新工具状态
      const updatedTools = message.tools?.map(tool => {
        // 取消时，将所有非最终态工具标记为 error
        if (
          tool.status === 'streaming' ||
          tool.status === 'queued' ||
          tool.status === 'awaiting_approval' ||
          tool.status === 'executing' ||
          tool.status === 'awaiting_apply'
        ) {
          return { ...tool, status: 'error' as const }
        }
        return tool
      })
      
      // 取消时若半截内容已经落盘，后端会回传稳定节点 ID；同步替换本地占位 ID，
      // 否则随后对该消息重试会把前端临时 ID 误发给分支图。
      const persistedId = typeof chunk.content?.id === 'string' && chunk.content.id.trim()
        ? chunk.content.id
        : message.id
      if (persistedId !== message.id && state.streamingMessageId.value === message.id) {
        state.streamingMessageId.value = persistedId
        // H1：平滑显示层键随占位 id → 持久化 id 迁移，避免按新 id 清理时残留旧条目
        migrateSmoothStreamForState(state, message.id, persistedId)
      }

      // 创建更新后的消息对象
      const updatedMessage: Message = {
        ...message,
        id: persistedId,
        streaming: false,
        // cancelled 场景：若消息非空，后端通常已持久化 partial（用户取消）。
        // 即使极端情况下未持久化，localOnly=false 也只会影响“是否走后端索引”的分支，
        // 但非空消息的 retry/delete 仍可由 error/reload 兜底。
        localOnly: false,
        metadata: newMetadata,
        tools: updatedTools
      }
      
      // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
      replaceMessageAt(state, messageIndex, updatedMessage)
    }
  }
  // 平滑流式：放完积压并清理显示文本（半截内容已由 cancelled 替换/保留）
  // 传占位 id：即使 streamingMessageId 已被迁移为持久化 id，也能命中迁移前的 manager entry
  finishSmoothStreamForState(state, streamMessageIdAtStart)
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false
  state.autoSummaryStatus.value = null
  state.pendingModelOverride.value = null
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
}

/**
 * 处理 error 类型
 */
export function handleError(chunk: StreamChunk, state: ChatStoreState): void {
  // H4：无 streamId 的迟到 error chunk：不删除新请求的占位消息，也不复位当前流状态。
  // 无 conversationId 时无法归属，保守只记错误不删消息；可归属的迟到 chunk 直接忽略。
  if (isLateTerminalChunkWithoutStreamId(chunk, state)) {
    if (!chunk.conversationId) {
      state.error.value = chunk.error || {
        code: 'STREAM_ERROR',
        message: 'Stream error'
      }
    }
    console.warn('[streamChunkHandlers] Late error chunk without streamId ignored (new stream active)', {
      conversationId: chunk.conversationId,
      createdAt: chunk.createdAt,
      streamingMessageId: state.streamingMessageId.value,
      activeStreamId: state.activeStreamId.value
    })
    return
  }

  // 竞态检测：与 handleCancelled 相同的逻辑
  const lastCancelledId = state._lastCancelledStreamId.value
  const isStaleCallback = !chunk.streamId && !!(
    lastCancelledId &&
    state.streamingMessageId.value &&
    state.streamingMessageId.value !== lastCancelledId
  )

  if (isStaleCallback) {
    // 迟到的旧请求 error chunk：不重置新请求的全局状态，仅记录错误
    state._lastCancelledStreamId.value = null
    console.warn('[streamChunkHandlers] Stale error chunk ignored (new request in progress)')
    return
  }

  state.error.value = chunk.error || {
    code: 'STREAM_ERROR',
    message: 'Stream error'
  }
  
  // 平滑流式：放完积压并清理显示文本（半截消息已保留/删除）。
  // 必须在 streamingMessageId 置 null 之前调用：finishSmoothStreamForState 依赖
  // streamingMessageId 定位 manager entry，置空后 ids 为空会 no-op 导致条目泄漏（H1）。
  finishSmoothStreamForState(state)

  if (state.streamingMessageId.value) {
    const errorMessageIndex = getMessageIndexById(state, state.streamingMessageId.value)
    const messageToRemove = errorMessageIndex >= 0 ? state.allMessages.value[errorMessageIndex] : undefined
    
    // 删除空的占位消息（不依赖 streaming 标记；网络中断等场景可能已被提前置为非 streaming）
    // 注意：思考内容只存在于 parts 中，不在 content 中，需要检查 parts
    const hasPartsContent = !!messageToRemove?.parts?.some(p => p.text || p.functionCall)
    if (messageToRemove && !messageToRemove.content && !messageToRemove.tools && !hasPartsContent) {
      const removeIndex = getMessageIndexById(state, state.streamingMessageId.value)
      removeMessageAt(state, removeIndex)
      state._failedStreamMessageId.value = null
    } else if (messageToRemove) {
      // 有内容的半截消息：保留展示，但记录其 ID，
      // 供 retryAfterError 在重试前回滚（后端从未持久化该消息）。
      state._failedStreamMessageId.value = messageToRemove.id
    } else {
      state._failedStreamMessageId.value = null
    }
    state.streamingMessageId.value = null
  } else {
    state._failedStreamMessageId.value = null
  }
  
  state.activeStreamId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false  // 结束等待
  state.autoSummaryStatus.value = null
  state.pendingModelOverride.value = null
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
}
