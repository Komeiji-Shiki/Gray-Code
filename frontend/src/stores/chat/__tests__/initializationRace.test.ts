import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, vi } from 'vitest'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const runtime = vi.hoisted(() => ({
  sendToExtension: vi.fn(),
  onMessageFromExtension: vi.fn(() => vi.fn())
}))

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  onMessageFromExtension: runtime.onMessageFromExtension
}))

import { useChatStore } from '../../chatStore'

describe('chatStore 首次初始化竞态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    runtime.sendToExtension.mockReset()
    runtime.onMessageFromExtension.mockClear()
  })

  test('首次 await 前建立空白标签页，异步加载结束不覆盖期间创建的会话与消息', async () => {
    const workspaceRequest = deferred<string | null>()
    runtime.sendToExtension.mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return workspaceRequest.promise
      if (type === 'settings.getActiveChannelId') return Promise.resolve({})
      if (type === 'checkpoint.getConfig') return Promise.resolve({ config: {} })
      if (type === 'conversation.listConversations') return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    const store = useChatStore()
    const initialization = store.initialize()

    // initialize() 返回 Promise 前就必须有可归属的空白标签页；首条消息发送会固化这个 tabId。
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(store.openTabs[0].id)

    // 模拟初始化 IPC 在途期间首条消息已完成本地创建与乐观插入。
    store.currentConversationId = 'conv_during_init'
    store.openTabs[0].conversationId = 'conv_during_init'
    store.allMessages = [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2, localOnly: true }
    ]

    workspaceRequest.resolve('file:///workspace')
    await initialization

    expect(store.currentConversationId).toBe('conv_during_init')
    expect(store.openTabs[0].conversationId).toBe('conv_during_init')
    expect(store.allMessages.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
  })
})
