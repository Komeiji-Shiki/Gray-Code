/**
 * Chat Store 流式处理器 - 主入口
 * 
 * 将各种流式处理功能模块化：
 * - streamHelpers.ts: 辅助函数（消息操作、工具解析）
 * - streamChunkHandlers.ts: 各种 chunk 类型的处理函数
 */

import type { StreamChunk } from '../../types'
import type { ChatStoreState, CheckpointRecord } from './types'

import {
  handleChunkType,
  handleToolsExecuting,
  handleToolStatus,
  handleAwaitingConfirmation,
  handleToolIteration,
  handleComplete,
  handleCheckpoints,
  handleCancelled,
  handleError
} from './streamChunkHandlers'

// 重新导出辅助函数，保持向后兼容
export {
  addFunctionCallToMessage,
  addTextToMessage,
  processStreamingText,
  flushToolCallBuffer
} from './streamHelpers'

/**
 * 创建流式处理器上下文
 */
export interface StreamHandlerContext {
  state: ChatStoreState
  currentModelName: () => string
  addCheckpoint: (checkpoint: CheckpointRecord) => void
  updateConversationAfterMessage: () => Promise<void>
}

/**
 * 处理流式响应
 */
export function handleStreamChunk(
  chunk: StreamChunk,
  ctx: StreamHandlerContext
): void {
  const { state, currentModelName, addCheckpoint, updateConversationAfterMessage } = ctx
  
  // 只处理当前对话的流式响应
  if (chunk.conversationId !== state.currentConversationId.value) {
    return
  }
  
  switch (chunk.type) {
    case 'chunk':
      if (chunk.chunk && state.streamingMessageId.value) {
        handleChunkType(chunk, state)
      }
      break
      
    case 'toolsExecuting':
      handleToolsExecuting(chunk, state)
      break

    case 'toolStatus':
      handleToolStatus(chunk, state)
      break
      
    case 'awaitingConfirmation':
      handleAwaitingConfirmation(chunk, state, addCheckpoint)
      break
      
    case 'toolIteration':
      if (chunk.content) {
        handleToolIteration(chunk, state, currentModelName, addCheckpoint)
      }
      break
      
    case 'complete':
      if (chunk.content) {
        handleComplete(chunk, state, addCheckpoint, updateConversationAfterMessage)
      }
      break
      
    case 'checkpoints':
      handleCheckpoints(chunk, addCheckpoint)
      break
      
    case 'cancelled':
      handleCancelled(chunk, state)
      break
      
    case 'error':
      handleError(chunk, state)
      break
  }
}
