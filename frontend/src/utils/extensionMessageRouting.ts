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
 * 显式广播消息类型白名单。
 *
 * 扩展端主动推送的消息（命令 / 流式 chunk / 更新 / 进度 / 事件等）都不携带 requestId，
 * 且类型必须出现在此集合中才会被广播给订阅者；其余类型一律忽略。
 *
 * 修改原因：请求超时（如 20s 兜底）后 requestId 会从 pendingRequests 摘除，后端稍后返回的
 * 响应（携带 requestId 与 type）不再有匹配的等待者——过去会落进「有 type 即广播」分支，
 * 被当作主动推送消息分发给所有订阅者（后台任务回执、流式状态等被误消费）。
 * 修改方式：带 requestId 但无匹配等待者的消息按「迟到响应」静默丢弃并记录 debug 日志；
 * 只有不带 requestId 且命中广播类型白名单的消息才进入 broadcast。
 */
const BROADCAST_MESSAGE_TYPES = new Set([
  'command',
  'streamChunk',
  'streamChunkBatch',
  'workspaceUri',
  'workspaceList',
  'retryStatus',
  'taskEvent',
  'terminalOutput',
  'imageGenOutput',
  'dependencyProgress',
  'storageMigrationProgress',
  'subagentMonitor.event',
  'subagentMonitor.manifest',
  // 远控端会话变更（创建/改名/删除/摘要更新）→ 桌面端最近对话列表实时刷新
  'conversationsChanged'
])

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
    // 保留后端 sendError 的错误码（code）：调用方 catch 中统一按 err.code 取错误码
    // （如 INTERRUPT_MESSAGE_RATE_LIMITED / MESSAGE_CHANGED），丢弃会导致错误码丢失
    const error = new Error(payload.error?.message || 'Unknown error') as Error & { code?: string }
    if (payload.error?.code) {
      error.code = payload.error.code
    }
    handler.reject(error)
    return 'rejected'
  }

  // 带 requestId 但无匹配等待者：请求已超时被摘除（或被其他监听器消费），
  // 这是迟到的响应而非推送消息——静默丢弃，防止被当作广播误分发。
  if (requestId) {
    console.debug('[extensionMessageRouting] dropped stale response (requestId not pending):', requestId)
    return 'ignored'
  }

  // 无 requestId：只有显式声明为广播的消息类型才分发
  if (!payload.type || !BROADCAST_MESSAGE_TYPES.has(payload.type)) {
    return 'ignored'
  }

  broadcast(payload)
  return 'broadcast'
}
