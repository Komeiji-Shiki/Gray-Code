/**
 * 排队消息“立即发送”回归测试。
 *
 * 覆盖：当前回合仍在运行时，右侧发送箭头必须通过 preserveSubAgents 取消旧流，
 * 让后端先把前台 SubAgent 转为后台；随后才启动新消息流。
 */
import { beforeEach, describe, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async (type: string) => (
    type === 'getWorkspaceUri' ? null : { success: true }
  )),
  onMessageFromExtension: vi.fn(() => () => {})
}))

import { sendToExtension } from '../../utils/vscode'
import { useChatStore } from '../../stores/chatStore'

describe('sendQueuedMessageNow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendToExtension).mockClear()
  })

  test('先以 preserveSubAgents 取消旧流，再发送排队消息', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_queue'
    store.isStreaming = true
    store.isWaitingForResponse = true

    store.enqueueMessage('新的问题')
    const queuedId = store.messageQueue[0].id
    vi.mocked(sendToExtension).mockClear()

    await store.sendQueuedMessageNow(queuedId)

    const calls = vi.mocked(sendToExtension).mock.calls
    const cancelIndex = calls.findIndex(([type]) => type === 'cancelStream')
    const streamIndex = calls.findIndex(([type]) => type === 'chatStream')

    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(streamIndex).toBeGreaterThan(cancelIndex)
    expect(calls[cancelIndex][1]).toEqual({
      conversationId: 'conv_queue',
      preserveSubAgents: true
    })
    expect(store.messageQueue).toHaveLength(0)
  })
})
