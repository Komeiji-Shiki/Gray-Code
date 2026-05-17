import type { ChatStoreState } from '../../../frontend/src/stores/chat/types'
import type { Message } from '../../../frontend/src/types'
import { syncFoldedHistoryHint, trimWindowFromTop } from '../../../frontend/src/stores/chat/windowUtils'

function refValue<T>(value: T): { value: T } {
  return { value }
}

function makeMessage(index: number, role: Message['role'] = index % 2 === 0 ? 'user' : 'assistant'): Message {
  return {
    id: `msg-${index}`,
    role,
    content: `message ${index}`,
    timestamp: index,
    backendIndex: index
  }
}

function createWindowState(startIndex: number, count: number): ChatStoreState {
  return {
    allMessages: refValue(Array.from({ length: count }, (_, i) => makeMessage(startIndex + i))),
    windowStartIndex: refValue(startIndex),
    totalMessages: refValue(startIndex + count),
    checkpoints: refValue([]),
    historyFolded: refValue(startIndex > 0),
    foldedMessageCount: refValue(startIndex > 0 ? startIndex : 0)
  } as unknown as ChatStoreState
}

describe('windowUtils history folding hints', () => {
  it('syncs folded count from current window start instead of accumulating trims', () => {
    const state = createWindowState(120, 920)

    const removed = trimWindowFromTop(state, 800)

    expect(removed).toBeGreaterThan(0)
    expect(state.windowStartIndex.value).toBeGreaterThan(120)
    expect(state.historyFolded.value).toBe(true)
    expect(state.foldedMessageCount.value).toBe(state.windowStartIndex.value)
  })

  it('keeps older messages loaded by upward paging and refreshes hint without trimming them again', () => {
    const state = createWindowState(120, 800)
    const olderMessages = Array.from({ length: 120 }, (_, i) => makeMessage(i))

    state.allMessages.value = [...olderMessages, ...state.allMessages.value]
    state.windowStartIndex.value = 0
    syncFoldedHistoryHint(state)

    expect(state.allMessages.value).toHaveLength(920)
    expect(state.allMessages.value[0].backendIndex).toBe(0)
    expect(state.historyFolded.value).toBe(false)
    expect(state.foldedMessageCount.value).toBe(0)
  })
})
