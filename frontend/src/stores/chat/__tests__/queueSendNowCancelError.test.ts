/**
 * sendQueuedMessageNow 在 cancelStream 抛错时的队列消息保底回归测试
 （fix/bugfix-scan-round）。
 *
 * 背景：立即发送先 removeQueuedMessage 再 await deps.cancelStream()，无异常保护；
 * cancelStream 抛错时 sendMessage 不执行、消息也没有放回队首，排队消息被静默丢弃。
 *
 * 修复：cancelStream 包进 try/catch——抛错时把消息放回队首保持原顺序并 rethrow，
 * 保证任何路径下队列消息不丢失。
 */
import { describe, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatStoreState, QueuedMessage } from '../types'
import { sendQueuedMessageNow, type QueueActionDeps } from '../queueActions'

function mockState(queue: QueuedMessage[], isWaiting = false): ChatStoreState {
  return {
    messageQueue: ref(queue),
    isWaitingForResponse: ref(isWaiting)
  } as unknown as ChatStoreState
}

function makeQueuedMessage(id: string, content = 'hello'): QueuedMessage {
  return {
    id,
    content,
    attachments: [],
    timestamp: 1,
    conversationId: 'conv_1'
  }
}

describe('sendQueuedMessageNow：cancelStream 抛错保底', () => {
  test('cancelStream 抛错时消息放回队首并向上 rethrow', async () => {
    const item = makeQueuedMessage('q1')
    const state = mockState([item], true)
    const cancelError = new Error('cancel exploded')
    const deps: QueueActionDeps = {
      sendMessage: vi.fn().mockResolvedValue(true),
      cancelStream: vi.fn().mockRejectedValue(cancelError)
    }

    await expect(sendQueuedMessageNow(state, deps, 'q1')).rejects.toThrow('cancel exploded')
    // 消息回到队首（未被静默丢弃）
    expect(state.messageQueue.value).toEqual([item])
    // cancelStream 抛错后不得继续发送
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

  test('cancelStream 成功但 sendMessage 返回 false 时仍放回队首（既有语义保持）', async () => {
    const item = makeQueuedMessage('q2')
    const state = mockState([item], true)
    const deps: QueueActionDeps = {
      sendMessage: vi.fn().mockResolvedValue(false),
      cancelStream: vi.fn().mockResolvedValue(undefined)
    }

    await sendQueuedMessageNow(state, deps, 'q2')
    expect(state.messageQueue.value).toEqual([item])
  })

  test('空闲时不调用 cancelStream，发送成功后队列清空', async () => {
    const item = makeQueuedMessage('q3')
    const state = mockState([item], false)
    const deps: QueueActionDeps = {
      sendMessage: vi.fn().mockResolvedValue(true),
      cancelStream: vi.fn()
    }

    await sendQueuedMessageNow(state, deps, 'q3')
    expect(deps.cancelStream).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledWith('hello', [], undefined)
    expect(state.messageQueue.value).toEqual([])
  })
})
