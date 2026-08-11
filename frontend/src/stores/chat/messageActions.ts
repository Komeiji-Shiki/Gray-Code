/**
 * Chat Store 消息操作（模块化拆分后的 re-export 壳）
 *
 * 实现已按生命周期拆入 messageActions/ 子目录：
 * - sendMessageFlow.ts：发送主流程（sendMessage + 私有辅助，含共享工具）
 * - retryFlows.ts：重试家族（retryLastMessage / retryFromMessage / retryAfterError / editAndRetry）
 * - deleteFlows.ts：删除流程（deleteMessage / deleteSingleMessage）
 * - summaryFlows.ts：上下文总结（summarizeContext / cancelSummarizeRequest / restoreSummarizedMessages）
 * - interruptNotices.ts：忙时投递（U1）模块级 TTL 通知
 *
 * 本文件仅 re-export，导出符号与拆分前完全一致；chatStore / toolActions /
 * checkpointActions / queueActions / MessageList / 测试等既有 import 零改动。
 */

// ---- 发送主流程 ----
export {
  calculateBackendIndex,
  sendMessage,
  rollbackFailedStreamMessage
} from './messageActions/sendMessageFlow'
export type {
  CancelStreamCallback,
  HiddenFunctionResponsePayload,
  SendMessageOptions
} from './messageActions/sendMessageFlow'

// ---- 重试家族 ----
export {
  retryLastMessage,
  retryFromMessage,
  dismissError,
  RETRYABLE_ERROR_CODES,
  isRetryableError,
  retryAfterError,
  editAndRetry
} from './messageActions/retryFlows'

// ---- 删除流程 ----
export { deleteMessage, deleteSingleMessage } from './messageActions/deleteFlows'

// ---- 上下文总结 ----
export { summarizeContext, cancelSummarizeRequest, restoreSummarizedMessages } from './messageActions/summaryFlows'

// ---- 忙时投递（U1）通知 ----
export {
  INTERRUPT_MESSAGE_MAX_LENGTH,
  INTERRUPT_NOTICE_TTL_MS,
  INTERRUPT_NOTICE_MAX,
  recentInterruptDeliveries,
  recordInterruptDelivery,
  clearInterruptDeliveries
} from './messageActions/interruptNotices'
export type { InterruptDeliveryNotice } from './messageActions/interruptNotices'
