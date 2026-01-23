/**
 * 流式 Chunk 处理器
 * 
 * 处理各种类型的 StreamChunk
 */

import type { Message, StreamChunk } from '../../types'
import type { ChatStoreState, CheckpointRecord } from './types'
import { generateId } from '../../utils/format'
import { contentToMessage } from './parsers'
import {
  addTextToMessage,
  processStreamingText,
  flushToolCallBuffer,
  handleFunctionCallPart
} from './streamHelpers'

/**
 * 处理 chunk 类型
 */
export function handleChunkType(chunk: StreamChunk, state: ChatStoreState): void {
  const message = state.allMessages.value.find(m => m.id === state.streamingMessageId.value)
  if (message && chunk.chunk?.delta) {
    // 初始化 parts（如果不存在）
    if (!message.parts) {
      message.parts = []
    }
    
    // chunk.chunk 是 BackendStreamChunk，包含 delta 数组
    // delta 是 ContentPart 数组，每个元素可能包含 text 或 functionCall
    for (const part of chunk.chunk.delta) {
      if (part.text) {
        if (part.thought) {
          // 思考内容：直接添加，不检测工具调用
          addTextToMessage(message, part.text, true)
        } else {
          // 普通文本：处理文本，检测 XML/JSON 工具调用标记
          processStreamingText(message, part.text, state)
        }
      }
      
      // 处理工具调用（原生 function call format）
      if (part.functionCall) {
        handleFunctionCallPart(part, message)
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

  const messageIndex = state.allMessages.value.findIndex(m => m.id === state.streamingMessageId.value)

  if (messageIndex !== -1 && chunk.content) {
    const message = state.allMessages.value[messageIndex]

    // 保存原有的 modelVersion 和 tools
    // 注意：必须保留原始 tools，因为 contentToMessage 会将工具状态设为 success
    const existingModelVersion = message.metadata?.modelVersion
    const existingTools = message.tools

    const finalMessage = contentToMessage(chunk.content, message.id)

    // 合并 tools（优先保留 existingTools 的状态；缺失时用 finalMessage.tools 补齐）
    const mergedTools = (() => {
      const a = existingTools || []
      const b = finalMessage.tools || []
      if (a.length === 0) return b
      if (b.length === 0) return a
      const map = new Map<string, any>()
      for (const t of a) map.set(t.id, t)
      for (const t of b) {
        if (!map.has(t.id)) map.set(t.id, t)
      }
      return Array.from(map.values())
    })()

    // 创建更新后的消息对象
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      streaming: false,
      // toolsExecuting 阶段的 content 已写入后端历史（模型消息已持久化）
      localOnly: false,
      tools: mergedTools.length > 0 ? mergedTools : undefined
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
        // AI 输出完成后，工具如果还停留在 streaming，则进入 queued
        const baseStatus = tool.status === 'streaming' ? 'queued' : tool.status

        if (executingId && tool.id === executingId) {
          return { ...tool, status: 'executing' as const }
        }
        if (queuedIds.has(tool.id)) {
          return { ...tool, status: 'queued' as const }
        }
        return { ...tool, status: baseStatus as any }
      })
    }

    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    state.allMessages.value = [
      ...state.allMessages.value.slice(0, messageIndex),
      updatedMessage,
      ...state.allMessages.value.slice(messageIndex + 1)
    ]
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
    const idx = all.findIndex(m => m.id === state.streamingMessageId.value)
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

  state.allMessages.value = [
    ...all.slice(0, messageIndex),
    updatedMessage,
    ...all.slice(messageIndex + 1)
  ]
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
  const messageIndex = state.allMessages.value.findIndex(m => m.id === state.streamingMessageId.value)
  if (messageIndex !== -1 && chunk.content) {
    const message = state.allMessages.value[messageIndex]
    // 保存原有的 modelVersion
    const existingModelVersion = message.metadata?.modelVersion
    const existingTools = message.tools

    const finalMessage = contentToMessage(chunk.content, message.id)

    // 合并 tools（优先保留 existingTools 的状态；缺失时用 finalMessage.tools 补齐）
    const mergedTools = (() => {
      const a = existingTools || []
      const b = finalMessage.tools || []
      if (a.length === 0) return b
      if (b.length === 0) return a
      const map = new Map<string, any>()
      for (const t of a) map.set(t.id, t)
      for (const t of b) {
        if (!map.has(t.id)) map.set(t.id, t)
      }
      return Array.from(map.values())
    })()

    // 创建更新后的消息对象
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
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

    // 标记工具为等待确认状态，并同步已有的工具结果
    if (updatedMessage.tools) {
      const pendingIds = new Set((chunk.pendingToolCalls || []).map((t: any) => t.id))
      const toolResults = chunk.toolResults || []
      const toolResultMap = new Map(toolResults.map(r => [r.id, r]))

      // 使用 map 创建新数组
      updatedMessage.tools = updatedMessage.tools.map(tool => {
        // AI 输出完成后，工具如果还停留在 streaming，则进入 queued
        const baseStatus = tool.status === 'streaming' ? 'queued' : tool.status

        if (pendingIds.has(tool.id)) {
          // 轮到该工具，等待用户批准
          return { ...tool, status: 'awaiting_approval' as const }
        }
        
        // 如果有自动执行的结果，更新状态为 success
        if (toolResultMap.has(tool.id)) {
          const result = toolResultMap.get(tool.id)!.result as any
          const status = (result.cancelled || result.rejected)
            ? ('error' as const)
            : ('success' as const)
          return { ...tool, status, result }
        }
        
        return { ...tool, status: baseStatus as any }
      })
    }

    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    state.allMessages.value = [
      ...state.allMessages.value.slice(0, messageIndex),
      updatedMessage,
      ...state.allMessages.value.slice(messageIndex + 1)
    ]
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
        isFunctionResponse: true,
        parts: newParts
      }
      state.allMessages.value.push(responseMessage)
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
  const messageIndex = state.allMessages.value.findIndex(m => m.id === state.streamingMessageId.value)
  
  // 检查是否有工具被取消或拒绝
  const cancelledToolIds = new Set<string>()
  const rejectedToolIds = new Set<string>()
  if (chunk.toolResults) {
    for (const r of chunk.toolResults) {
      if ((r.result as any).cancelled && r.id) {
        cancelledToolIds.add(r.id)
      }
      if ((r.result as any).rejected && r.id) {
        rejectedToolIds.add(r.id)
      }
    }
  }
  const hasCancelledTools = cancelledToolIds.size > 0
  
  if (messageIndex !== -1) {
    const message = state.allMessages.value[messageIndex]
    // 保存原有的 tools 信息和 modelVersion
    const existingTools = message.tools
    const existingModelVersion = message.metadata?.modelVersion
    
    const finalMessage = contentToMessage(chunk.content!, message.id)
    
    // 恢复原有的 modelVersion，同时保留后端返回的计时信息
    if (finalMessage.metadata) {
      if (existingModelVersion) {
        finalMessage.metadata.modelVersion = existingModelVersion
      }
      // 清除 thinkingStartTime（因为思考已完成，后端已返回 thinkingDuration）
      delete finalMessage.metadata.thinkingStartTime
    }
    
    // 恢复 tools 信息
    let restoredTools = finalMessage.tools
    if (existingTools && (!restoredTools || restoredTools.length === 0)) {
      restoredTools = existingTools
    }
    
    // 更新工具状态：被取消或拒绝的工具标记为 error，其他标记为 success
    if (restoredTools) {
      restoredTools = restoredTools.map(tool => ({
        ...tool,
        status: (cancelledToolIds.has(tool.id) || rejectedToolIds.has(tool.id)) ? 'error' as const : 'success' as const
      }))
    }
    
    // 创建更新后的消息对象（确保 Vue 响应式更新）
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      streaming: false,
      // toolIteration 阶段的 content 已写入后端历史（模型消息已持久化）
      localOnly: false,
      tools: restoredTools
    }
    
    // 用新对象替换数组中的旧对象
    state.allMessages.value = [
      ...state.allMessages.value.slice(0, messageIndex),
      updatedMessage,
      ...state.allMessages.value.slice(messageIndex + 1)
    ]
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
        isFunctionResponse: true,
        parts
      }
      state.allMessages.value.push(responseMessage)
    }
  }
  
  // 处理新创建的检查点
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }
  
  // 如果有工具被取消，结束 streaming 状态，不继续后续 AI 响应
  if (hasCancelledTools) {
    state.streamingMessageId.value = null
    state.isStreaming.value = false
    state.isWaitingForResponse.value = false
    return
  }
  
  // 创建新的占位消息用于接收后续 AI 响应
  const newAssistantMessageId = generateId()
  const newAssistantMessage: Message = {
    id: newAssistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
    localOnly: true,
    metadata: {
      modelVersion: currentModelName()
    }
  }
  state.allMessages.value.push(newAssistantMessage)
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
  const messageIndex = state.allMessages.value.findIndex(m => m.id === state.streamingMessageId.value)
  if (messageIndex !== -1) {
    const message = state.allMessages.value[messageIndex]
    // 刷新工具调用缓冲区
    flushToolCallBuffer(message, state)
    // 保存原有的 modelVersion（使用创建时的模型，不从 API 响应更新）
    const existingModelVersion = message.metadata?.modelVersion
    
    const finalMessage = contentToMessage(chunk.content!, message.id)
    
    // 恢复原有的 modelVersion
    if (existingModelVersion && finalMessage.metadata) {
      finalMessage.metadata.modelVersion = existingModelVersion
    }
    
    // 创建更新后的消息对象
    const updatedMessage: Message = {
      ...message,
      ...finalMessage,
      streaming: false,
      // complete 代表后端已持久化该模型消息
      localOnly: false
    }
    
    // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
    state.allMessages.value = [
      ...state.allMessages.value.slice(0, messageIndex),
      updatedMessage,
      ...state.allMessages.value.slice(messageIndex + 1)
    ]
  }
  
  // 处理新创建的检查点
  if (chunk.checkpoints && chunk.checkpoints.length > 0) {
    for (const cp of chunk.checkpoints) {
      addCheckpoint(cp)
    }
  }
  
  state.streamingMessageId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false  // 结束等待
  
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
 * 处理 cancelled 类型
 */
export function handleCancelled(chunk: StreamChunk, state: ChatStoreState): void {
  // 用户取消了请求
  // 尝试获取目标消息：优先使用 streamingMessageId，如果已清除则尝试寻找最后一条助手消息
  let messageIndex = -1
  if (state.streamingMessageId.value) {
    messageIndex = state.allMessages.value.findIndex(m => m.id === state.streamingMessageId.value)
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
      state.allMessages.value = state.allMessages.value.filter((_, i) => i !== messageIndex)
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
      
      // 创建更新后的消息对象
      const updatedMessage: Message = {
        ...message,
        streaming: false,
        // cancelled 场景：若消息非空，后端通常已持久化 partial（用户取消）。
        // 即使极端情况下未持久化，localOnly=false 也只会影响“是否走后端索引”的分支，
        // 但非空消息的 retry/delete 仍可由 error/reload 兜底。
        localOnly: false,
        metadata: newMetadata,
        tools: updatedTools
      }
      
      // 用新对象替换数组中的旧对象，确保 Vue 响应式更新
      state.allMessages.value = [
        ...state.allMessages.value.slice(0, messageIndex),
        updatedMessage,
        ...state.allMessages.value.slice(messageIndex + 1)
      ]
    }
  }
  state.streamingMessageId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false
}

/**
 * 处理 error 类型
 */
export function handleError(chunk: StreamChunk, state: ChatStoreState): void {
  state.error.value = chunk.error || {
    code: 'STREAM_ERROR',
    message: 'Stream error'
  }
  
  if (state.streamingMessageId.value) {
    const messageToRemove = state.allMessages.value.find(m => m.id === state.streamingMessageId.value)
    
    // 删除空的占位消息（不依赖 streaming 标记；网络中断等场景可能已被提前置为非 streaming）
    // 注意：思考内容只存在于 parts 中，不在 content 中，需要检查 parts
    const hasPartsContent = !!messageToRemove?.parts?.some(p => p.text || p.functionCall)
    if (messageToRemove && !messageToRemove.content && !messageToRemove.tools && !hasPartsContent) {
      state.allMessages.value = state.allMessages.value.filter(m => m.id !== state.streamingMessageId.value)
    }
    state.streamingMessageId.value = null
  }
  
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false  // 结束等待
}
