import { ref } from 'vue'

/** 搜索/外部导航使用的绝对历史消息定位目标，索引为 0-based。 */
export interface MessageJumpTarget {
  conversationId?: string
  index?: number
  id?: string
  /** 搜索结果字段别名，保持与正文搜索契约兼容。 */
  messageIndex?: number
  messageId?: string
}

const pendingMessageJump = ref<MessageJumpTarget | null>(null)

/**
 * 请求当前聊天视图定位到一条消息。
 * 请求可以早于对话页加载完成，MessageList 会在对应会话出现后消费它。
 */
export function jumpToMessage(target: MessageJumpTarget): void {
  const rawIndex = target.index ?? target.messageIndex
  const rawId = target.id ?? target.messageId
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
    ? Math.max(0, Math.floor(rawIndex))
    : undefined
  const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : undefined
  if (index === undefined && !id) return
  pendingMessageJump.value = {
    ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(id ? { id } : {})
  }
}

export function takeMessageJump(conversationId: string | null): MessageJumpTarget | null {
  const target = pendingMessageJump.value
  if (!target) return null
  if (target.conversationId && target.conversationId !== conversationId) return null
  pendingMessageJump.value = null
  return target
}

export function peekMessageJump(conversationId: string | null): MessageJumpTarget | null {
  const target = pendingMessageJump.value
  if (!target || target.conversationId && target.conversationId !== conversationId) return null
  return target
}

export function clearMessageJump(): void {
  pendingMessageJump.value = null
}
