/**
 * 流式 Chunk 处理器 —— complete / cancelled / error（含 handleCheckpoints）相关
 *
 * 拆分自 streamChunkHandlers.ts（模块化重构第 4 批，纯移动、逻辑不改）。
 * 共享状态与辅助函数从 ./chunkText 导入，保持模块级单例：
 * - fcSeenBodies：随流终结清空（done 分支同款），避免旧轮参数体污染下一轮流
 * - resetTurnBaseTokenEstimate：清空本轮 base 估算（替代原内联的 turnBaseTokens = 0）
 * - contentToPersistedMessage / finishSmoothStreamForState / migrateSmoothStreamForState
 */

import type { Message, StreamChunk } from '../../../types'
import type { ChatStoreState, CheckpointRecord } from '../types'
import { setTotalMessagesFromWindow } from '../windowUtils'
import { isPerfEnabled } from '../../../utils/perf'
import { getMessageIndexById, removeMessageAt, replaceMessageAt } from '../state'
import {
  contentToPersistedMessage,
  finishSmoothStreamForState,
  migrateSmoothStreamForState,
  fcSeenBodies,
  resetTurnBaseTokenEstimate
} from './chunkText'

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
 * 处理 complete 类型
 */
export function handleComplete(
  chunk: StreamChunk,
  state: ChatStoreState,
  addCheckpoint: (checkpoint: CheckpointRecord) => void,
  updateConversationAfterMessage: () => Promise<void>
): void {
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
  state.pendingConfigIdOverride.value = null
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
  // 工具参数增量计数跟踪随流终结清空（与 cancelled/error 终结路径统一），
  // 覆盖“无 done-delta 直接 complete”的场景，避免旧轮参数体污染下一轮流
  fcSeenBodies.clear()
  
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
    // 多模态附件（inlineData/fileData）也是有效内容，不能按空消息删除
    const hasPartsContent = message.parts && message.parts.some(p => p.text || p.functionCall || p.inlineData || p.fileData)
    if (!message.content && !message.tools && !hasPartsContent) {
      removeMessageAt(state, messageIndex)
      // 删除空占位后回退 totalMessages（窗口推导），保持与窗口长度一致
      setTotalMessagesFromWindow(state)
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
        if (chunk.content.ttft !== undefined) {
          newMetadata.ttft = chunk.content.ttft
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
  // 本轮 base 估算不参与下轮校准：被中止的流累计的字符混入下一次流的 realTokens 会拉偏因子
  resetTurnBaseTokenEstimate()
  // 工具参数增量计数跟踪随流终结清空（与 done 分支同款），避免残留跨流污染
  fcSeenBodies.clear()
  state.autoSummaryStatus.value = null
  state.pendingModelOverride.value = null
  state.pendingConfigIdOverride.value = null
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
    // 多模态附件（inlineData/fileData）也是有效内容，不能按空消息删除
    const hasPartsContent = !!messageToRemove?.parts?.some(p => p.text || p.functionCall || p.inlineData || p.fileData)
    if (messageToRemove && !messageToRemove.content && !messageToRemove.tools && !hasPartsContent) {
      const removeIndex = getMessageIndexById(state, state.streamingMessageId.value)
      removeMessageAt(state, removeIndex)
      // 删除空占位后回退 totalMessages（窗口推导），保持与窗口长度一致
      setTotalMessagesFromWindow(state)
      state._failedStreamMessageId.value = null
    } else if (messageToRemove) {
      // 有内容的半截消息：保留展示，但记录其 ID，
      // 供 retryAfterError 在重试前回滚（后端从未持久化该消息）。
      // 与 handleCancelled 的保留路径一致，结束其流式渲染标志——
      // 否则 loading 指示器/光标永久闪烁（无后续 chunk 会再置它）。
      if (messageToRemove.streaming) {
        replaceMessageAt(state, errorMessageIndex, { ...messageToRemove, streaming: false })
      }
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
  state.pendingConfigIdOverride.value = null
  // 与 handleCancelled 一致：本轮 base 估算不参与下轮校准（中止流的字符混入会拉偏因子）
  resetTurnBaseTokenEstimate()
  // 工具参数增量计数跟踪随流终结清空（与 done 分支同款），避免残留跨流污染
  fcSeenBodies.clear()
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
}
