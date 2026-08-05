import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async () => ({ success: true })),
  onMessageFromExtension: vi.fn(() => () => {})
}))

import { sendToExtension } from '../../utils/vscode'
import { createChatState } from '../../stores/chat/state'
import { cancelStream } from '../../stores/chat/toolActions'
import type { ChatStoreComputed } from '../../stores/chat/types'

describe('cancelStream immediate feedback', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockReset()
  })

  it('后端清理尚未返回时立即清除流式与等待状态', async () => {
    let resolveCancel: ((value: unknown) => void) | undefined
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'cancelStream') {
        return new Promise(resolve => {
          resolveCancel = resolve
        })
      }
      return Promise.resolve({ success: true })
    })

    const state = createChatState()
    state.currentConversationId.value = 'conv_cancel_immediate'
    state.streamingMessageId.value = 'assistant_streaming'
    state.activeStreamId.value = 'stream_request_1'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    state.isLoading.value = true
    state.allMessages.value = [{
      id: 'assistant_streaming',
      role: 'assistant',
      content: 'partial response',
      streaming: true,
      timestamp: Date.now()
    } as any]

    const cancelPromise = cancelStream(state, {} as ChatStoreComputed)
    await Promise.resolve()

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.isLoading.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.allMessages.value[0]?.streaming).toBe(false)
    expect(resolveCancel).toBeTypeOf('function')

    resolveCancel?.({ cancelled: true })
    await cancelPromise
  })

  it('只有 isStreaming 为真时也会发送取消，不被 isWaitingForResponse 早退吞掉', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({ cancelled: true })
    const state = createChatState()
    state.currentConversationId.value = 'conv_cancel_stream_only'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = false

    await cancelStream(state, {} as ChatStoreComputed)

    expect(sendToExtension).toHaveBeenCalledWith('cancelStream', {
      conversationId: 'conv_cancel_stream_only'
    })
  })
})
