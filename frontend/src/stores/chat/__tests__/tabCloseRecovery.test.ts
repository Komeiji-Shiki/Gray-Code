import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ConfigInfo } from '../types'

const runtime = vi.hoisted(() => ({
  send: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}))

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: runtime.send,
  onMessageFromExtension: runtime.subscribe
}))

import { useChatStore } from '../../chatStore'

const configs: Record<string, ConfigInfo> = {
  'channel-a': { id: 'channel-a', name: '渠道 A', model: 'model-x', type: 'openai' },
  'channel-b': { id: 'channel-b', name: '渠道 B', model: 'model-y', type: 'openai' }
}

beforeEach(() => {
  setActivePinia(createPinia())
  runtime.send.mockReset().mockImplementation(async (type: string, params: Record<string, unknown>) => {
    if (type === 'config.getConfig') return configs[String(params.configId)]
    if (type === 'getWorkspaceUri') return null
    return { success: true }
  })
})

async function twoConversations() {
  const store = useChatStore()
  store.conversations = ['b', 'a'].map(id => ({
    id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0, isPersisted: true
  }))
  const tabB = store.createNewTab()
  if (!tabB) throw new Error('未创建标签 B')
  store.currentConversationId = 'b'
  store.configId = 'channel-b'
  store.selectedModelId = 'model-x'
  store.currentConfig = configs['channel-b']

  const tabA = store.createNewTab()
  if (!tabA) throw new Error('未创建标签 A')
  store.currentConversationId = 'a'
  store.configId = 'channel-a'
  store.selectedModelId = 'model-x'
  store.currentConfig = configs['channel-a']
  await flushPromises()
  runtime.send.mockClear()
  return { store, tabA, tabB }
}

test('关闭活动标签后恢复相邻渠道，并按会话中选择的模型发送', async () => {
  const { store, tabA, tabB } = await twoConversations()
  store.closeTab(tabA)
  await flushPromises()

  expect(store.activeTabId).toBe(tabB)
  expect(store.currentConversationId).toBe('b')
  expect(store.configId).toBe('channel-b')
  expect(store.currentConfig).toMatchObject(configs['channel-b'])
  expect(store.selectedModelId).toBe('model-x')
  expect(store.sessionSnapshots.has(tabA)).toBe(false)
  expect(await store.sendMessage('继续当前任务')).toBe(true)
  expect(runtime.send).toHaveBeenCalledWith('chatStream', expect.objectContaining({
    conversationId: 'b', configId: 'channel-b', modelOverride: 'model-x'
  }))
})

test('相邻渠道详情尚未返回时，发送不使用已关闭标签的默认模型判断', async () => {
  const { store, tabA, tabB } = await twoConversations()
  let finish!: (value: ConfigInfo) => void
  const loading = new Promise<ConfigInfo>(resolve => { finish = resolve })
  runtime.send.mockImplementation(async (type: string) => {
    if (type === 'config.getConfig') return loading
    if (type === 'getWorkspaceUri') return null
    return { success: true }
  })

  try {
    store.closeTab(tabA)
    expect(store.activeTabId).toBe(tabB)
    expect(await store.sendMessage('立即发送')).toBe(true)
    expect(runtime.send).toHaveBeenCalledWith('chatStream', expect.objectContaining({
      conversationId: 'b', configId: 'channel-b', modelOverride: 'model-x'
    }))
  } finally {
    finish(configs['channel-b'])
    await flushPromises()
  }
})

test('渠道详情读取期间继续关闭最后一个标签，新空白标签重新取得配置', async () => {
  const { store, tabA, tabB } = await twoConversations()
  let finishOld!: (value: ConfigInfo) => void
  let finishNew!: (value: ConfigInfo) => void
  const oldLoading = new Promise<ConfigInfo>(resolve => { finishOld = resolve })
  const newLoading = new Promise<ConfigInfo>(resolve => { finishNew = resolve })
  let configRequests = 0
  runtime.send.mockImplementation(async (type: string) => {
    if (type === 'config.getConfig') return ++configRequests === 1 ? oldLoading : newLoading
    if (type === 'getWorkspaceUri') return null
    return { success: true }
  })

  try {
    store.closeTab(tabA)
    store.closeTab(tabB)
    expect(store.currentConversationId).toBeNull()
    expect(store.configId).toBe('channel-b')
    expect(store.openTabs).toHaveLength(1)
    expect(configRequests).toBe(2)

    finishOld(configs['channel-b'])
    await flushPromises()
    expect(store.currentConfig).toBeNull()
    finishNew(configs['channel-b'])
    await flushPromises()
    expect(store.currentConfig).toMatchObject(configs['channel-b'])
  } finally {
    finishOld(configs['channel-b'])
    finishNew(configs['channel-b'])
    await flushPromises()
  }
})
