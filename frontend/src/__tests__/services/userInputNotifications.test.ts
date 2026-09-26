import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { AgentStopNotificationController, type AgentStopNotificationControllerChatStore } from '../../services/agentStopNotificationController'
import { sendMessage } from '../../stores/chat/messageActions/sendMessageFlow'
import { recentInterruptDeliveries } from '../../stores/chat/messageActions/interruptNotices'
import type { ChatStoreComputed, ChatStoreState } from '../../stores/chat/types'
import type { Message } from '../../types'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn() }))
const host = window.__GRAYCODE_HOST
const controllers: AgentStopNotificationController[] = []
const soundSettings = { windowsAgentStopNotification: { enabled: true, onlyWhenWindowNotFocused: false,
  cases: { error: true, awaitingUserAction: true, continueRequired: true }, content: {} } } as any
const flush = async () => { await nextTick(); await Promise.resolve(); await nextTick() }

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(sendToExtension).mockReset().mockResolvedValue({ success: true })
  recentInterruptDeliveries.value = []
  window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof host>
})
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  window.__GRAYCODE_HOST = host
  vi.clearAllTimers(); vi.useRealTimers()
})

function fixture(streaming = true) {
  const state = { currentConversationId: ref('task-a'), isStreaming: ref(streaming), isWaitingForResponse: ref(true),
    error: ref(null), retryStatus: ref(null), allMessages: ref<Message[]>([]) } as ChatStoreState
  const store = reactive({ ...state, hasPendingToolConfirmation: !streaming, pendingToolCalls: [], needsContinueButton: false,
    currentConversation: null }) as unknown as AgentStopNotificationControllerChatStore
  const controller = new AgentStopNotificationController({ chatStore: store, sendToExtension, getSoundSettings: () => soundSettings })
  controllers.push(controller)
  return { state, store }
}

const nativeCalls = () => vi.mocked(sendToExtension).mock.calls.filter(([name]) => name === MESSAGE_NAMES['notifications.agentStop'] || name === MESSAGE_NAMES.showNotification)

describe('真实用户追加输入只保留应用内回执', () => {
  test.each([true, false])('忙时追加文字/附件的成功、拒绝和 RPC 失败均不触发 Windows 通知或停止状态（streaming=%s）', async streaming => {
    const { state, store } = fixture(streaming)
    for (const result of ['accepted', 'rejected', 'rpc-error']) {
      if (result === 'rpc-error') vi.mocked(sendToExtension).mockRejectedValueOnce(new Error('receipt lost'))
      else vi.mocked(sendToExtension).mockResolvedValueOnce({ success: result === 'accepted' })
      const sent = await sendMessage(state, {} as ChatStoreComputed, '补充信息', [{ id: 'image', name: 'shot.png', type: 'image', mimeType: 'image/png', size: 3, data: 'abc' }], { messageId: result })
      await flush()
      expect(sent).toBe(result === 'accepted')
      expect(recentInterruptDeliveries.value[0].kind).toBe(result === 'accepted' ? 'delivered' : 'error')
      expect(state.isStreaming.value).toBe(streaming); expect(state.isWaitingForResponse.value).toBe(true)
      expect(store.hasPendingToolConfirmation).toBe(!streaming); expect(store.error).toBeNull()
      expect(nativeCalls()).toEqual([])
    }
    expect(vi.mocked(sendToExtension).mock.calls.every(([name]) => name === MESSAGE_NAMES['chat.sendInterruptMessage'])).toBe(true)
  })

  test.each(['error', 'awaiting_user_action', 'continue_required'] as const)('追加输入不会吞掉稍后真正的 %s 停止通知', async reason => {
    const { state, store } = fixture()
    await sendMessage(state, {} as ChatStoreComputed, '补充信息', undefined, { messageId: 'input-1' })
    await flush(); expect(nativeCalls()).toEqual([])
    if (reason === 'error') store.error = { code: 'NETWORK_ERROR', message: '真实执行错误' }
    else if (reason === 'awaiting_user_action') {
      store.hasPendingToolConfirmation = true
      store.pendingToolCalls = [{ id: 'approval-1', name: 'write_file', args: { path: 'file.ts' }, status: 'awaiting_approval' }]
    }
    else store.needsContinueButton = true
    store.isStreaming = false; store.isWaitingForResponse = false
    await flush()
    expect(nativeCalls()).toEqual([[MESSAGE_NAMES['notifications.agentStop'], expect.objectContaining({ reason, conversationId: 'task-a' })]])
  })
})
