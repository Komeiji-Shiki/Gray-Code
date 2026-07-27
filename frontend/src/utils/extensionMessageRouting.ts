/**
 * 扩展消息分类规则。
 *
 * 修改原因：这套规则过去内联在 onMessageFromExtension 注册的每一个 window 监听器里，既无法单独回归，
 *          又因为被复制了十几份而产生真实缺陷——响应只会被第一个监听器兑现（它随即删掉 requestId），
 *          其余监听器查不到该 requestId，于是把这条响应当成主动推送消息交给了业务 handler。
 * 修改方式：抽成不依赖 window / vscode API 的纯函数，由唯一的全局分发器调用。
 * 修改目的：消息只被分类一次，且这条分类规则可以被测试锁定。
 */

export interface PendingRequestHandler<T = any> {
  resolve: (data: T) => void
  reject: (error: Error) => void
}

export type ExtensionMessageRoutingResult = 'ignored' | 'resolved' | 'rejected' | 'broadcast'

/**
 * 把一条来自扩展端的消息分派给等待中的请求或推送订阅者。
 *
 * @param message 原始消息（可能是任意值，非对象一律忽略）
 * @param pendingRequests 等待响应的请求表；命中后立即摘除，保证一个请求只兑现一次
 * @param broadcast 主动推送消息的广播出口
 */
export function routeExtensionMessage(
  message: unknown,
  pendingRequests: Map<string, PendingRequestHandler>,
  broadcast: (message: Record<string, any>) => void
): ExtensionMessageRoutingResult {
  if (!message || typeof message !== 'object') {
    return 'ignored'
  }

  const payload = message as Record<string, any>
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''

  if (requestId && pendingRequests.has(requestId)) {
    const handler = pendingRequests.get(requestId)!
    pendingRequests.delete(requestId)

    if (payload.success) {
      handler.resolve(payload.data)
      return 'resolved'
    }
    handler.reject(new Error(payload.error?.message || 'Unknown error'))
    return 'rejected'
  }

  if (!payload.type) {
    return 'ignored'
  }

  broadcast(payload)
  return 'broadcast'
}
