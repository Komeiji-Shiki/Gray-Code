/**
 * 流式 Chunk 处理器 —— toolStatus / toolStatusBatch / toolsExecuting /
 * toolIteration / awaitingConfirmation 相关
 *
 * 拆分自 streamChunkHandlers.ts（模块化重构第 4 批，纯移动、逻辑不改）。
 * 共享状态（fcSeenBodies / smoothBaseCache / activeFactor / turnBaseTokens）与
 * 共享辅助函数（contentToPersistedMessage / mergeToolsPreferExisting /
 * finishSmoothStreamForState 等）从 ./chunkText 导入，保持模块级单例。
 */

import type { Message, StreamChunk, ToolUsage, ToolExecutionResult } from '../../../types'
import type { ChatStoreState, CheckpointRecord } from '../types'
import { triggerRef } from 'vue'
import { generateId } from '../../../utils/format'
import { syncTotalMessagesFromWindow, trimWindowFromTop } from '../windowUtils'
import { appendMessage, buildToolResponseIndex, getMessageIndexById, replaceMessageAt } from '../state'
import { getToolApprovalStopKind } from '../../../utils/toolContinuations'
import {
  contentToPersistedMessage,
  mergeToolsPreferExisting,
  finishSmoothStreamForState
} from './chunkText'

function getNextBackendIndex(state: ChatStoreState): number {
  return state.windowStartIndex.value + state.allMessages.value.length
}

function normalizeStreamingToQueued(status?: ToolUsage['status']): ToolUsage['status'] | undefined {
  return status === 'streaming' ? 'queued' : status
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

    // 部分接受（用户拒绝了部分块或手动编辑内容）→ warning；与 apply_diff 返回的 partial 标记对齐
    if ((data as any).partial === true || (data as any).status === 'partial') return 'warning'

    const appliedCount = (data as any).appliedCount
    const failedCount = (data as any).failedCount
    if (typeof appliedCount === 'number' && typeof failedCount === 'number' && appliedCount > 0 && failedCount > 0) {
      return 'warning'
    }
  }

  return 'success'
}

/**
 * 处理 toolsExecuting 类型
 */
export function handleToolsExecuting(chunk: StreamChunk, state: ChatStoreState): void {
  // 工具开始执行时模型输出段已经结束；先保存迁移前占位 id，确保持久化 id 替换后
  // 旧、新两个键都能被 finishSmoothStreamForState 清理。
  const streamMessageIdAtStart = state.streamingMessageId.value

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

    // 诊断日志
    const fcCount = finalMessage.parts?.filter(p => p.functionCall).length ?? 0
    console.debug(`[handleToolsExecuting] msgId=${message.id} existingTools=${existingTools?.length ?? 0} contentTools=${finalMessage.tools?.length ?? 0} fcParts=${fcCount}`)

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
  }

  // toolsExecuting 是当前模型文本段的终点。放完积压并删除 smoothTexts，消息正文切回
  // 后端持久化的真实 parts；全局 isStreaming 仍保持 true，以便工具执行期间可以取消。
  finishSmoothStreamForState(state, streamMessageIdAtStart)
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
    // 复用权威索引 toolResponseIndex（appendMessage/rebuild 增量维护），避免每轮全量扫描窗口
    const existingResponseIds = state.toolResponseIndex.value

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
      if ((r.result as { cancelled?: boolean } | undefined)?.cancelled === true && r.id) {
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
    
    // 诊断日志
    const fcCount = finalMessage.parts?.filter(p => p.functionCall).length ?? 0
    console.debug(`[handleToolIteration] msgId=${message.id} existingTools=${existingTools?.length ?? 0} contentTools=${finalMessage.tools?.length ?? 0} fcParts=${fcCount}`)

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
    // 正常 store 始终持有权威索引；旧持久化状态或精简测试 state 缺失时，
    // 从当前窗口重建一次，避免 toolIteration 因状态升级而崩溃。
    const existingResponseIds = state.toolResponseIndex?.value
      ?? buildToolResponseIndex(state.allMessages.value)

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
