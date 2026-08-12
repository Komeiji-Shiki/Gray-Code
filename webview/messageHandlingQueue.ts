import { MESSAGE_NAMES } from '../shared/protocol'

export type WebviewMessageHandler = (message: any) => Promise<void>
export type WebviewMessageErrorHandler = (error: unknown) => void

/**
 * 判断消息是否必须绕过主 Webview 串行处理队列。
 *
 * webviewReady 是前端接收扩展命令的握手。它不能排在需要等待 BackendHost 初始化的
 * 普通请求后面，否则前置请求挂起时 pendingCommands（包括 newChat）永远无法 flush。
 */
export function shouldBypassWebviewMessageQueue(message: unknown): boolean {
  return !!message
    && typeof message === 'object'
    && !Array.isArray(message)
    && (message as { type?: unknown }).type === MESSAGE_NAMES.webviewReady
}

/**
 * 把一条主 Webview 消息安排到处理器。
 *
 * 普通消息保持严格串行；握手消息独立调度并原样返回当前队列，确保它不会等待队首任务。
 */
export function scheduleWebviewMessage(
  currentQueue: Promise<void>,
  message: any,
  handleMessage: WebviewMessageHandler,
  handleError: WebviewMessageErrorHandler
): Promise<void> {
  if (shouldBypassWebviewMessageQueue(message)) {
    void Promise.resolve()
      .then(() => handleMessage(message))
      .catch(handleError)
    return currentQueue
  }

  return currentQueue
    .then(() => handleMessage(message))
    .catch(handleError)
}
