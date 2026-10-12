import type { Message } from '../../types'
import type { ChatStoreState } from './types'
import type { AgentMessageCardInsertPayload } from '../backgroundTasks/bridge'
import { insertMessageAt, bumpMessagesStructuralVersion } from './state'
import { clearVisibleChatMessagesCache } from './windowUtils'

export function insertAgentMessageCard(state: ChatStoreState, payload: AgentMessageCardInsertPayload): void {
  const { card, persisted } = payload
  const all = state.allMessages.value
  // 幂等：同 mailbox messageId 已插入（taskEvent 重放/重复推送）
  if (all.some((m) => m.agentMessage?.messageId === card.messageId)) return

  let insertAt: number
  let backendIndex: number | undefined
  if (persisted) {
    if (typeof payload.insertPosition !== 'number') return
    insertAt = payload.insertPosition - state.windowStartIndex.value
    // 插入点必须真实位于当前窗口内；左右任一侧越界都交给后续历史加载。
    if (insertAt < 0 || insertAt > all.length) return
    backendIndex = payload.insertPosition
  } else {
    // 持久层连续失败：仍在当前窗口尾部展示本地卡片，但不伪造后端索引。
    insertAt = all.length
  }

  const message: Message = {
    id: `agentmsg:${card.messageId}`,
    role: 'user',
    content: '',
    timestamp: card.createdAt || Date.now(),
    source: 'agent_message',
    agentMessage: card,
    localOnly: !persisted,
    ...(backendIndex !== undefined ? { backendIndex } : {}),
  }
  insertMessageAt(state, insertAt, message)

  if (!persisted) return

  // 后端已把插入点之后的消息整体后移 1：窗口内带真实 backendIndex 的后端消息同步 +1。
  const next = state.allMessages.value
  let shifted = false
  for (let i = insertAt + 1; i < next.length; i++) {
    const m = next[i]
    if (!m.localOnly && typeof m.backendIndex === 'number') {
      next[i] = { ...m, backendIndex: m.backendIndex + 1 }
      shifted = true
    }
  }
  if (shifted) {
    clearVisibleChatMessagesCache(state)
    bumpMessagesStructuralVersion(state)
  }

  // transcript 已真实增加一条：同步后端总数和对话摘要，保证后续分页游标不漏页/重页。
  const backendWindowEnd = next.reduce(
    (max, item) => (!item.localOnly && typeof item.backendIndex === 'number' ? Math.max(max, item.backendIndex + 1) : max),
    0,
  )
  state.totalMessages.value = Math.max(state.totalMessages.value + 1, backendWindowEnd)
  const conversation = state.conversations.value.find((item) => item.id === state.currentConversationId.value)
  if (conversation) {
    conversation.messageCount = state.totalMessages.value
    conversation.updatedAt = Date.now()
  }
}
