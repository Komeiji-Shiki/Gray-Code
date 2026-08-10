/**
 * LimCode - 流式请求公共常量（backend/core 层）
 *
 * OLD_STREAM_EXIT_WAIT_TIMEOUT_MS 从 webview/stream/abort/RetiredStreamChain 下沉
 * （第五批层反转修复）：backend/modules/api/chat/services/ChatFlowService 不再依赖
 * webview 常量；webview/stream/StreamAbortManager 从本模块 re-export，保持既有消费方
 * （StreamRequestHandler / ConversationHandlers 等）不破坏。常量值逐字保持（6000ms）。
 */

/**
 * 旧流退出等待超时（毫秒）。
 *
 * 用户「停止后立即重发」时，新流必须在旧流完全退出（工具结算落盘、finally 注销控制器）
 * 后才能写入用户消息，否则旧流的结算 addContent 会落在新用户消息之后，历史出现半截旧回答/
 * 错位结算。旧流 abort 后通常在工具结算窗口（约 3s）+ 收尾窗口（约 2s）内退出，这里留出余量；
 * 超时兜底保证旧流异常挂死时也不会阻塞新流启动太久。
 */
export const OLD_STREAM_EXIT_WAIT_TIMEOUT_MS = 6000;
