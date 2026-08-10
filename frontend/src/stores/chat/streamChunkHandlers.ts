/**
 * 流式 Chunk 处理器（壳模块）
 *
 * 实现已按 chunk 类型拆分至 chunkHandlers/ 子目录（模块化重构第 4 批，纯移动、逻辑不改）：
 * - chunkHandlers/chunkText.ts: text/delta/usage/smooth 相关（含模块级状态单例）
 * - chunkHandlers/chunkTools.ts: toolStatus/toolStatusBatch/toolsExecuting/toolIteration/awaitingConfirmation
 * - chunkHandlers/chunkTerminal.ts: complete/cancelled/error/checkpoints
 * - chunkHandlers/chunkSummary.ts: autoSummaryStatus/autoSummary
 *
 * 本文件仅 re-export，导出面与拆分前完全一致（streamHandler.ts 及各测试的 import 不断）。
 */

export {
  resetTurnBaseTokenEstimate,
  finishSmoothStreamForState,
  clearAllSmoothForState,
  handleChunkType
} from './chunkHandlers/chunkText'
export {
  handleToolsExecuting,
  handleToolStatus,
  handleToolStatusBatch,
  handleAwaitingConfirmation,
  handleToolIteration
} from './chunkHandlers/chunkTools'
export {
  handleComplete,
  handleCheckpoints,
  handleCancelled,
  handleError
} from './chunkHandlers/chunkTerminal'
export {
  handleAutoSummaryStatus,
  handleAutoSummary
} from './chunkHandlers/chunkSummary'
