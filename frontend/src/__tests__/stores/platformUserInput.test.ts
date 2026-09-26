import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { createChatState, appendMessage } from '../../stores/chat/state'
import { sendMessage } from '../../stores/chat/messageActions/sendMessageFlow'
import { recentInterruptDeliveries } from '../../stores/chat/messageActions/interruptNotices'
import type { Attachment } from '../../types'
import type { ChatStoreComputed } from '../../stores/chat/types'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn() }))
const originalHost = window.__GRAYCODE_HOST
const screenshot: Attachment = { id: 'image-1', type: 'image', name: 'screen.png', mimeType: 'image/png', size: 4, data: 'AAAA', thumbnail: 'thumb' }

function setup() {
  const state = createChatState()
  state.currentConversationId.value = 'conversation'
  state.activeStreamId.value = 'live-stream'
  state.streamingMessageId.value = 'tool-message'
  state.isWaitingForResponse.value = true
  appendMessage(state, { id: 'tool-message', role: 'assistant', content: '', timestamp: 1,
    tools: [{ id: 'delete-call', name: 'delete_file', args: { paths: ['fixture.txt'] }, status: 'awaiting_approval', approvalId: 'approval-1' }] })
  return state
}

describe('独立端忙时完整用户输入', () => {
  beforeEach(() => {
    window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof originalHost>
    vi.mocked(sendToExtension).mockReset().mockResolvedValue({ success: true, queued: true, messageId: 'stored-user-input', runId: 'run-1' })
    recentInterruptDeliveries.value = []
  })
  afterEach(() => { window.__GRAYCODE_HOST = originalHost })

  test.each(['最新输入'.repeat(1200), ''])('长文本/仅截图与附件顺序原样交付，审批和流不变', async text => {
    const state = setup()
    const secondImage = { ...screenshot, id: 'image-2', name: 'second.png', data: 'BBBB' }
    expect(await sendMessage(state, {} as ChatStoreComputed, text, [screenshot, secondImage],
      { messageId: 'request-1', deepSeekVisionTileSplit: false })).toBe(true)
    expect(sendToExtension).toHaveBeenCalledExactlyOnceWith('chat.sendInterruptMessage', {
      conversationId: 'conversation', text, messageId: 'request-1', attachments: [screenshot, secondImage], deepSeekVisionTileSplit: false
    })
    expect(state.activeStreamId.value).toBe('live-stream')
    expect(state.streamingMessageId.value).toBe('tool-message')
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(state.allMessages.value).toHaveLength(1)
    expect(state.allMessages.value[0].tools?.[0]).toMatchObject({ status: 'awaiting_approval', approvalId: 'approval-1' })
    expect(recentInterruptDeliveries.value[0]).toMatchObject({ conversationId: 'conversation', kind: 'delivered', text: text || 'screen.png, second.png' })
  })

  test('接收失败返回 false 供原稿重试，不取消运行、另起用户回合或写成功回显', async () => {
    const state = setup()
    vi.mocked(sendToExtension).mockResolvedValue({ success: false, error: { code: 'INTERRUPT_NO_ACTIVE_RUN', message: '任务已结束' } })
    expect(await sendMessage(state, {} as ChatStoreComputed, 'latest', [screenshot], { messageId: 'request-1' })).toBe(false)
    expect(sendToExtension).toHaveBeenCalledTimes(1)
    expect(recentInterruptDeliveries.value[0]).toMatchObject({ kind: 'error', errorCode: 'INTERRUPT_NO_ACTIVE_RUN' })
    expect(state.activeStreamId.value).toBe('live-stream')
    expect(state.allMessages.value).toHaveLength(1)
    vi.mocked(sendToExtension).mockResolvedValue({ success: true, queued: true })
    expect(await sendMessage(state, {} as ChatStoreComputed, 'latest', [screenshot], { messageId: 'request-1' })).toBe(true)
    expect(vi.mocked(sendToExtension).mock.calls[1][1]).toEqual(vi.mocked(sendToExtension).mock.calls[0][1])
  })

  test('回执丢失后运行已收尾，原稿重试仍查询同一接收 ID，不另开重复回合', async () => {
    const state = setup()
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(sendToExtension).mockRejectedValueOnce(new Error('connection lost after save'))
      expect(await sendMessage(state, {} as ChatStoreComputed, 'latest', [screenshot], { messageId: 'request-lost' })).toBe(false)
      state.activeStreamId.value = null
      state.streamingMessageId.value = null
      state.isWaitingForResponse.value = false
      vi.mocked(sendToExtension).mockResolvedValue({ success: true, queued: true })
      expect(await sendMessage(state, {} as ChatStoreComputed, 'latest', [screenshot], { messageId: 'request-lost' })).toBe(true)
      expect(vi.mocked(sendToExtension).mock.calls.map(([type]) => type)).toEqual(['chat.sendInterruptMessage', 'chat.sendInterruptMessage'])
      expect(vi.mocked(sendToExtension).mock.calls[1][1]).toEqual(vi.mocked(sendToExtension).mock.calls[0][1])
      expect(state.activeStreamId.value).toBeNull()
      expect(state.isWaitingForResponse.value).toBe(false)
    } finally { log.mockRestore() }
  })

  test('跨会话晚到回执仅归属提交会话，不修改新流', async () => {
    const state = setup()
    let resolve!: (value: unknown) => void
    vi.mocked(sendToExtension).mockImplementation(() => new Promise(done => { resolve = done }))
    const sending = sendMessage(state, {} as ChatStoreComputed, 'latest', [screenshot], { messageId: 'request-1' })
    state.currentConversationId.value = 'another-conversation'
    state.activeStreamId.value = 'another-stream'
    resolve({ success: true, queued: true })
    expect(await sending).toBe(true)
    expect(state.activeStreamId.value).toBe('another-stream')
    expect(recentInterruptDeliveries.value[0].conversationId).toBe('conversation')
  })

  test.each(['agent_message', 'background_task'] as const)('内部来源 %s 不得误走真实用户输入通道', async source => {
    const state = setup()
    expect(await sendMessage(state, {} as ChatStoreComputed, 'internal result', undefined, { source })).toBe(false)
    expect(sendToExtension).not.toHaveBeenCalled()
    expect(state.activeStreamId.value).toBe('live-stream')
    expect(state.allMessages.value[0].tools?.[0].status).toBe('awaiting_approval')
  })
})
