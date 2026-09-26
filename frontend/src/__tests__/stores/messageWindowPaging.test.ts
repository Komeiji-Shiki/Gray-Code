import { describe, expect, test, vi } from 'vitest'
import { createChatState } from '../../stores/chat/state'
import { loadMessagesAroundIndex } from '../../stores/chat/conversationActions'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn() }))

describe('消息定位分页的归属与窗口边界', () => {
  test('居中页按请求大小读取连续索引，重叠区不产生重复消息', async () => {
    const state = createChatState()
    state.currentConversationId.value = 'conversation'
    vi.mocked(sendToExtension).mockResolvedValueOnce({ total: 1250, messages: Array.from({ length: 400 }, (_, offset) => ({
      id: `m-${800 + offset}`, index: 800 + offset, role: 'user', parts: [{ text: 'message' }]
    })) })
    expect(await loadMessagesAroundIndex(state, 1000, { pageSize: 400 })).toBe(true)
    expect(sendToExtension).toHaveBeenLastCalledWith('conversation.getMessagesPaged', {
      conversationId: 'conversation', offset: 800, limit: 400
    })
    expect(state.windowStartIndex.value).toBe(800)
    expect(state.allMessages.value.map(message => message.backendIndex)).toEqual(Array.from({ length: 400 }, (_, index) => index + 800))
    expect(new Set(state.allMessages.value.map(message => message.id)).size).toBe(400)
  })

  test('读取较新页期间切换会话，迟到页不写入新会话或清掉新请求标记', async () => {
    const state = createChatState()
    state.currentConversationId.value = 'first'
    let finish!: (result: unknown) => void
    vi.mocked(sendToExtension).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = loadMessagesAroundIndex(state, 1000, { pageSize: 400 })
    state.currentConversationId.value = 'second'
    state.allMessages.value = [{ id: 'second-message', role: 'user', content: 'second', timestamp: 0, backendIndex: 0 }]
    state.windowStartIndex.value = 0
    finish({ total: 1200, messages: [{ id: 'first-message', index: 1000, role: 'user', parts: [{ text: 'first' }] }] })
    expect(await pending).toBe(false)
    expect(state.allMessages.value.map(message => message.id)).toEqual(['second-message'])
    expect(state.windowStartIndex.value).toBe(0)
    expect(state.isLoadingMoreMessages.value).toBe(true)
  })
})
