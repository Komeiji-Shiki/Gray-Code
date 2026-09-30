import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createChatState, appendMessage } from '../state'
import { cancelStream, cancelStreamAndRejectTools } from '../toolActions'
import { handleStreamChunk } from '../streamHandler'
import { sendToExtension } from '../../../utils/vscode'

vi.mock('../../../utils/vscode', () => ({ sendToExtension: vi.fn() }))

function activeState() {
  const state = createChatState()
  state.currentConversationId.value = 'conversation-a'
  state.activeStreamId.value = 'run-a'
  state.streamingMessageId.value = 'message-a'
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  appendMessage(state, { id: 'message-a', role: 'assistant', content: '已有内容', timestamp: 1,
    streaming: true, backendIndex: 0, tools: [{ id: 'tool-a', name: 'write_file', args: {}, status: 'executing' }] })
  return state
}

describe('独立宿主取消回执', () => {
  let previousHost: typeof window.__GRAYCODE_HOST
  beforeEach(() => {
    previousHost = window.__GRAYCODE_HOST
    window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof previousHost>
    vi.mocked(sendToExtension).mockReset()
  })
  afterEach(() => { window.__GRAYCODE_HOST = previousHost })

  test.each([cancelStream, cancelStreamAndRejectTools])('等待服务端确认期间继续保留运行，成功后清理显示状态', async cancel => {
    let finish!: (value: unknown) => void
    vi.mocked(sendToExtension).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const state = activeState()
    const cancellation = cancel(state, {} as any)
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(state.activeStreamId.value).toBe('run-a')
    expect(state.allMessages.value[0].tools?.[0].status).toBe('executing')
    expect(state.allMessages.value).toHaveLength(1)
    finish({ success: true })
    await cancellation
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.activeStreamId.value).toBeNull()
    expect(state._lastCancelledStreamId.value?.streamId).toBe('run-a')
  })

  test.each([cancelStream, cancelStreamAndRejectTools])('超时回执不伪造已取消或工具拒绝结果', async cancel => {
    vi.mocked(sendToExtension).mockResolvedValue({ success: false, code: 'RUN_CANCEL_TIMEOUT' })
    const state = activeState()
    await expect(cancel(state, {} as any)).rejects.toMatchObject({ code: 'RUN_CANCEL_TIMEOUT' })
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(state.activeStreamId.value).toBe('run-a')
    expect(state._lastCancelledStreamId.value).toBeNull()
    expect(state.allMessages.value).toHaveLength(1)
    expect(state.allMessages.value[0].tools?.[0].status).toBe('executing')
    expect(state.error.value?.code).toBe('RUN_CANCEL_TIMEOUT')
  })

  test('连接失败与缺少明确成功的回执同样可重试', async () => {
    const state = activeState()
    vi.mocked(sendToExtension).mockRejectedValueOnce(new Error('连接断开')).mockResolvedValueOnce({}).mockResolvedValueOnce({ success: true })
    await expect(cancelStream(state, {} as any)).rejects.toThrow('连接断开')
    expect(state.error.value?.details).toBe('连接断开')
    await expect(cancelStream(state, {} as any)).rejects.toMatchObject({ code: 'CANCEL_ERROR' })
    expect(state.isStreaming.value).toBe(true)
    await cancelStream(state, {} as any)
    expect(state.error.value).toBeNull()
  })

  test.each([{ success: true }, { success: false, code: 'RUN_CANCEL_TIMEOUT' }])('切会话后迟到的回执不改变新会话运行或错误', async receipt => {
    let finish!: (value: unknown) => void
    vi.mocked(sendToExtension).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const state = activeState()
    const cancellation = cancelStream(state, {} as any).catch(() => undefined)
    state.currentConversationId.value = 'conversation-b'
    state.activeStreamId.value = 'run-b'
    state.streamingMessageId.value = 'message-b'
    state.error.value = null
    finish(receipt)
    await cancellation
    expect(state.currentConversationId.value).toBe('conversation-b')
    expect(state.activeStreamId.value).toBe('run-b')
    expect(state.streamingMessageId.value).toBe('message-b')
    expect(state.isStreaming.value).toBe(true)
    expect(state.error.value).toBeNull()
    expect(sendToExtension).toHaveBeenCalledWith('cancelStream', { conversationId: 'conversation-a' })
  })

  test('取消等待期间到达的真实完成回复不会被迟到成功回执改写', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(sendToExtension).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const state = activeState()
    const cancellation = cancelStream(state, {} as any)
    handleStreamChunk({ type: 'complete', conversationId: 'conversation-a', streamId: 'run-a',
      content: { id: 'saved-final', role: 'model', parts: [{ text: '最终回复' }] } }, {
      state, currentModelName: () => '测试模型', addCheckpoint: vi.fn(), updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(), processQueueAfterAction: vi.fn()
    })
    finish({ success: true })
    expect(await cancellation).toEqual({ cancelled: true })
    expect(state.allMessages.value.map(message => message.id)).toEqual(['saved-final'])
    expect(state.allMessages.value[0].content).toBe('最终回复')
    expect(state._lastCancelledStreamId.value).toBeNull()
  })
})
