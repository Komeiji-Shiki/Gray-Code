import type { ChatStoreState } from './types'
import { perfLog } from '../../utils/perf'

/** 默认消息窗口上限（包含 functionResponse 等隐藏消息） */
export const MAX_WINDOW_MESSAGES = 800

/**
 * 用窗口推导并同步“已知总消息数”
 *
 * windowStartIndex 是绝对索引，因此 windowStartIndex + window.length 代表当前窗口覆盖到的末尾索引（近似总数）。
 */
export function syncTotalMessagesFromWindow(state: ChatStoreState): void {
  state.totalMessages.value = Math.max(state.totalMessages.value, state.windowStartIndex.value + state.allMessages.value.length)
}

/** 将 totalMessages 直接设置为当前窗口覆盖到的总数（用于 delete/回档等会减少历史长度的操作） */
export function setTotalMessagesFromWindow(state: ChatStoreState): void {
  state.totalMessages.value = Math.max(0, state.windowStartIndex.value + state.allMessages.value.length)
}

/**
 * 裁剪消息窗口（从顶部丢弃更早消息）
 *
 * 返回：被丢弃的消息条数（包含 functionResponse）。
 */
export function trimWindowFromTop(state: ChatStoreState, maxCount = MAX_WINDOW_MESSAGES): number {
  const all = state.allMessages.value
  const overflow = all.length - maxCount
  if (overflow <= 0) return 0

  state.allMessages.value = all.slice(overflow)
  state.windowStartIndex.value += overflow

  // 清理窗口外的检查点，避免长期累积
  state.checkpoints.value = state.checkpoints.value.filter(cp => cp.messageIndex >= state.windowStartIndex.value)

  // 标记已发生折叠（用于 UI 提示）
  state.historyFolded.value = true
  state.foldedMessageCount.value += overflow

  syncTotalMessagesFromWindow(state)

  perfLog('conversation.window.trim', {
    removed: overflow,
    start: state.windowStartIndex.value,
    count: state.allMessages.value.length,
    total: state.totalMessages.value
  })

  return overflow
}
