import { MESSAGE_NAMES } from '@shared/protocol'
import { beforeEach, describe, expect, vi } from 'vitest'

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

  test('后端清理尚未返回时立即清除流式与等待状态', async () => {
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

  test('只有 isStreaming 为真时也会发送取消，不被 isWaitingForResponse 早退吞掉', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({ cancelled: true })
    const state = createChatState()
    state.currentConversationId.value = 'conv_cancel_stream_only'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = false

    await cancelStream(state, {} as ChatStoreComputed)

    expect(sendToExtension).toHaveBeenCalledWith(MESSAGE_NAMES.cancelStream, {
      conversationId: 'conv_cancel_stream_only'
    })
  })

  test('preserveSubAgents 将未完成子代理标记为后台，不显示错误状态', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({ cancelled: true })
    const state = createChatState()
    state.currentConversationId.value = 'conv_detach_subagent'
    state.streamingMessageId.value = 'assistant_with_subagent'
    state.activeStreamId.value = 'stream_with_subagent'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    state.allMessages.value = [{
      id: 'assistant_with_subagent',
      role: 'assistant',
      content: '',
      streaming: true,
      timestamp: Date.now(),
      tools: [{
        id: 'subagent_call_1',
        name: 'subagents',
        args: { agentName: '代码审核者', prompt: 'review' },
        status: 'executing'
      }]
    } as any]

    await cancelStream(state, {} as ChatStoreComputed, { preserveSubAgents: true })

    expect(state.allMessages.value[0]?.tools?.[0]?.status).toBe('background')
    const response = state.allMessages.value
      .flatMap(message => message.parts || [])
      .find(part => part.functionResponse?.id === 'subagent_call_1')
      ?.functionResponse?.response
    expect(response).toMatchObject({ success: true, detached: true, background: true })
    expect(sendToExtension).toHaveBeenCalledWith(MESSAGE_NAMES.cancelStream, {
      conversationId: 'conv_detach_subagent',
      preserveSubAgents: true
    })
  })
})
