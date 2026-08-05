/**
 * Chat Store 流式处理器 - 主入口
 * 
 * 将各种流式处理功能模块化：
 * - streamHelpers.ts: 辅助函数（消息操作、工具解析）
 * - streamChunkHandlers.ts: 各种 chunk 类型的处理函数
 */

import type { StreamChunk } from '../../types'
import type { ChatStoreState, CheckpointRecord } from './types'
import { nextTick } from 'vue'
import { bufferBackgroundChunk, updateTabStreamingStatus } from './tabActions'

import {
  handleChunkType,
  handleToolsExecuting,
  handleToolStatus,
  handleToolStatusBatch,
  handleAwaitingConfirmation,
  handleToolIteration,
  handleComplete,
  handleCheckpoints,
  handleAutoSummaryStatus,
  handleAutoSummary,
  handleCancelled,
  handleError
} from './streamChunkHandlers'
import { loadBranchGraph } from './branchActions'

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
  /** AI 响应结束后处理消息队列 */
  processQueue: () => Promise<void>
}

/**
 * 复位终结事件（complete/toolIteration）的流式状态。
 *
 * 后端可能发送 content 为 null/undefined 的终结 chunk：
 * 此时消息内容替换无法进行，但流式状态必须无条件复位，
 * 否则 isStreaming/isWaitingForResponse/streamingMessageId 永久残留，
 * 界面会一直卡在“等待响应”。
 */
function resetTerminalStreamState(state: ChatStoreState): void {
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state.isStreaming.value = false
  state.isWaitingForResponse.value = false
  state.autoSummaryStatus.value = null
  state.pendingModelOverride.value = null
  state._lastApprovalGatedStreamId.value = null
  state._lastCancelledStreamId.value = null
}

function warnLateApprovalGatedChunk(chunk: StreamChunk, state: ChatStoreState): void {
  if (!chunk.streamId || chunk.streamId !== state._lastApprovalGatedStreamId.value) {
    return
  }

  console.warn('[streamHandler] Late chunk ignored for approval-gated stream', {
    conversationId: chunk.conversationId,
    streamId: chunk.streamId,
    type: chunk.type
  })
  state._lastApprovalGatedStreamId.value = null
}

/**
 * reroll / 编辑分支流终结后刷新分支图（TREE-01/TREE-03 前端接入）。
 *
 * retryFromMessage / editAndRetry / restoreAndRetry / restoreAndEdit 发起
 * chat.rerollStream / chat.editBranchStream 前置位（值为发起流的会话 ID）；
 * 本函数在终结事件（complete / 终结性 toolIteration / error / cancelled）后消费该标记：
 * 刷新分支图（fire-and-forget）并复位——新候选落图后 BranchSwitcherBar 才能显示
 * 「‹ 2/2 ›」切换器（失败候选也保留，决策 10：可切回查看）。
 *
 * 会话隔离：标记只被“发起流所在的会话”的终结 chunk 消费——
 * 当前会话与标记会话不一致时保持惰性（不刷新其他会话的分支图），
 * 待切回原会话后由该会话的终结 chunk（或后台缓冲 flush）消费。
 */
function maybeRefreshBranchAfterStream(state: ChatStoreState): void {
  const pendingConversationId = state._pendingBranchRefreshAfterStream.value
  if (!pendingConversationId) return
  if (pendingConversationId !== state.currentConversationId.value) return
  state._pendingBranchRefreshAfterStream.value = null
  // fire-and-forget：刷新不阻塞 chunk 处理；loadBranchGraph 内部按当前会话读取并校验归属
  void loadBranchGraph(state)
}

/**
 * 消费当前分支流的重放上下文。
 *
 * 成功/取消时直接清理；只有包装后的分支流错误才写入 ErrorInfo，普通 API_ERROR 等仍沿用 retryStream。
 */
function finishBranchStreamTracking(state: ChatStoreState, preserveForBranchError = false): void {
  const replayContext = state._pendingBranchReplayContext.value
  if (replayContext?.conversationId === state.currentConversationId.value) {
    const error = state.error.value
    const isMatchingBranchError = !!error && (
      (replayContext.kind === 'reroll' && error.code === 'REROLL_ERROR') ||
      (replayContext.kind === 'editBranch' && error.code === 'EDIT_BRANCH_ERROR')
    )
    if (preserveForBranchError && isMatchingBranchError) {
      state.error.value = {
        ...error,
        branchReplayContext: replayContext
      }
    }
    state._pendingBranchReplayContext.value = null
  }
  maybeRefreshBranchAfterStream(state)
}

/**
 * 处理单条流式响应
 */
export function handleStreamChunk(
  chunk: StreamChunk,
  ctx: StreamHandlerContext
): void {
  const { state, currentModelName, addCheckpoint, updateConversationAfterMessage, processQueue } = ctx
  
  // 非当前活跃对话的流式响应 -> 缓冲到后台并更新标签页状态
  if (chunk.conversationId !== state.currentConversationId.value) {
    bufferBackgroundChunk(state, chunk)
    updateTabStreamingStatus(state, chunk)
    return
  }

  // 同一对话可能并发/串行触发多次流式请求，
  // 通过 streamId 只接收“当前活跃请求”的 chunk，避免迟到 chunk 污染新请求状态。
  const activeStreamId = state.activeStreamId.value
  if (chunk.streamId && !activeStreamId) {
    warnLateApprovalGatedChunk(chunk, state)
    return
  }

  if (activeStreamId && chunk.streamId !== activeStreamId) {
    warnLateApprovalGatedChunk(chunk, state)
    return
  }

  // 更新当前活跃标签页的流式状态
  updateTabStreamingStatus(state, chunk)
  
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
        // 工具迭代可能因「需用户确认 / 审批门闸 / 工具被取消」而终结流（后端不再发 complete）：
        // handleToolIteration 终结路径会把 activeStreamId 置空，据此消费分支图刷新标记；
        // 非终结路径（继续下一轮工具循环）activeStreamId 保持原值，不提前消费。
        if (state.activeStreamId.value === null) {
          finishBranchStreamTracking(state)
        }
      } else {
        // 无 content 的终结 chunk：仅复位流式状态，跳过消息内容替换
        resetTerminalStreamState(state)
        finishBranchStreamTracking(state)
      }
      break
      
    case 'complete':
      if (chunk.content) {
        handleComplete(chunk, state, addCheckpoint, updateConversationAfterMessage)
      } else {
        // 无 content 的终结 chunk：仅复位流式状态，跳过消息内容替换
        resetTerminalStreamState(state)
      }
      finishBranchStreamTracking(state)
      nextTick(() => processQueue())
      break
      
    case 'checkpoints':
      handleCheckpoints(chunk, addCheckpoint)
      break

    case 'autoSummaryStatus':
      handleAutoSummaryStatus(chunk, state)
      break

    case 'autoSummary':
      handleAutoSummary(chunk, state)
      break
      
    case 'cancelled':
      handleCancelled(chunk, state)
      finishBranchStreamTracking(state)
      nextTick(() => processQueue())
      break

    case 'error':
      handleError(chunk, state)
      finishBranchStreamTracking(state, true)
      nextTick(() => processQueue())
      break
  }
}

/**
 * 批量处理多条流式响应（性能优化）。
 *
 * 优化策略：
 * 1. 如果 batch 中包含携带替代内容的终结事件（complete/toolsExecuting/toolIteration/awaitingConfirmation），
 *    跳过该终结事件之前的所有 chunk 类型消息（因为终结事件会用后端权威数据覆盖前端流式状态），
 *    避免对即将被覆盖的 partialArgs 做无意义的 JSON.parse。
 * 2. 将连续的 toolStatus chunk 合并为一次 allMessages 替换。
 * 3. 整个批量在同一同步上下文中完成，
 * Vue 会自动将所有响应式变更合并为一次组件更新。
 */
export function handleStreamChunkBatch(
  chunks: StreamChunk[],
  ctx: StreamHandlerContext
): void {
  const { state } = ctx
  const activeConversationId = state.currentConversationId.value
  const activeStreamId = state.activeStreamId.value

  const isChunkForCurrentActiveStream = (chunk: StreamChunk): boolean => {
    if (chunk.conversationId !== activeConversationId) return false
    if (chunk.streamId && !activeStreamId) return false
    if (!activeStreamId || !chunk.streamId) return true
    return chunk.streamId === activeStreamId
  }

  // 查找 batch 中最后一个终结事件的位置
  // 终结事件会用后端权威数据完整覆盖前端流式状态，
  // 所以终结事件之前的 chunk 类型消息可以全部跳过
  // 注意：仅包含"携带替代内容"的终结事件（它们通过 contentToMessage 替换消息）。
  // error/cancelled 不在此列，因为它们不携带替代内容，
  // 其处理器依赖消息已有的内容来决定是否删除消息——
  // 如果跳过前面的 chunk，消息会被误判为空并删除，导致内容闪现后消失。
  const TERMINAL_TYPES = new Set(['complete', 'toolsExecuting', 'toolIteration', 'awaitingConfirmation'])
  let lastTerminalIndex = -1
  for (let k = chunks.length - 1; k >= 0; k--) {
    const candidate = chunks[k]
    if (!TERMINAL_TYPES.has(candidate.type)) {
      continue
    }
    // H3：content-less 终结 chunk（后端可能只发终结信号、不携带替代内容，见
    // resetTerminalStreamState 注释）不触发“跳过前序增量”优化——其前序 chunk 的增量
    // 解析不能被跳过，否则整段回答会因内容无处落地而空白。
    // handleStreamChunk 对这类终结 chunk 只做状态复位，消息内容完全依赖前序增量累积。
    if (!candidate.content) {
      continue
    }
    // stale stream / 非当前会话的终结事件不应触发“跳过前序 chunk”优化，
    // 否则可能误跳过当前活跃请求的有效增量。
    if (isChunkForCurrentActiveStream(candidate)) {
      lastTerminalIndex = k
      break
    }
  }

  // 计算需要跳过的 chunk 范围上界：
  // 终结事件之前的所有 'chunk' 类型消息的增量解析是浪费的（即将被终结事件覆盖），
  // 但 checkpoints/toolStatus 等非 chunk 消息仍需正常处理
  let skipChunksBefore = 0
  if (lastTerminalIndex > 0) {
    skipChunksBefore = lastTerminalIndex

    // 诊断日志：记录被跳过的 chunk 事件信息，方便排查工具调用消失等问题
    if (typeof console !== 'undefined' && console.debug) {
      const skippedChunks = chunks.slice(0, skipChunksBefore).filter(c => c.type === 'chunk')
      if (skippedChunks.length > 0) {
        const terminalType = chunks[lastTerminalIndex]?.type
        const hasFunctionCall = skippedChunks.some(c =>
          c.chunk?.delta?.some((p: any) => p.functionCall)
        )
        console.debug(`[streamHandler] batch skip: ${skippedChunks.length} chunk(s) before terminal '${terminalType}'${hasFunctionCall ? ' (contains functionCall delta!)' : ''}`)
      }
    }
  }

  let i = 0
  while (i < chunks.length) {
    const chunk = chunks[i]

    // 跳过终结事件之前的 chunk 类型（增量解析即将被覆盖，纯属浪费）
    if (chunk.type === 'chunk' && i < skipChunksBefore) {
      i++
      continue
    }

    // 对连续的 toolStatus chunk，收集为一组批量处理
    if (
      chunk.type === 'toolStatus' &&
      isChunkForCurrentActiveStream(chunk)
    ) {
      const batch: StreamChunk[] = [chunk]
      let j = i + 1
      while (
        j < chunks.length &&
        chunks[j].type === 'toolStatus' &&
        isChunkForCurrentActiveStream(chunks[j])
      ) {
        batch.push(chunks[j])
        j++
      }

      if (batch.length > 1) {
        // 批量标签页状态更新（只取最后一条）
        updateTabStreamingStatus(state, batch[batch.length - 1])
        handleToolStatusBatch(batch, state)
      } else {
        // 只有一条，走常规路径
        handleStreamChunk(chunk, ctx)
      }
      i = j
    } else {
      handleStreamChunk(chunk, ctx)
      i++
    }
  }
}
