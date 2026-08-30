/**
 * ChannelSettings - 外部批量变更（设置导入）后重拉渠道列表
 *
 * 背景：设置导入把渠道配置写进后端后，渠道设置页仍是挂载时拉取的快照
 * （且有模块级预加载缓存），用户必须重启插件才能看到刚导入的渠道。
 * 修复：组件订阅 channels.configChanged，对「不带 configId」的批量变更通知重拉全量列表，
 * 并复用 syncSelectedConfigId 修正选中态；带 configId 的是本组件自身单次编辑，忽略。
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import ChannelSettings from '../ChannelSettings.vue'
import { resetChannelConfigsCache, getChannelConfigsCache } from '@/services/channelConfigCache'

const { chatStoreMock, commandHandlers, onExtensionCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (data: any) => void>()
  return {
    chatStoreMock: {
      configId: '',
      loadCurrentConfig: vi.fn().mockResolvedValue(undefined),
      setSelectedModelId: vi.fn().mockResolvedValue(undefined),
      setConfigId: vi.fn().mockResolvedValue(undefined)
    },
    commandHandlers: handlers,
    onExtensionCommand: vi.fn((command: string, handler: (data: any) => void) => {
      handlers.set(command, handler)
      return () => handlers.delete(command)
    })
  }
})

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn(),
  onExtensionCommand
}))

vi.mock('@/stores', () => ({
  useChatStore: () => chatStoreMock
}))

import { sendToExtension } from '@/utils/vscode'
const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

/** 后端侧渠道数据：测试中直接改写它，模拟「导入完成、后端已多出一条配置」 */
let serverConfigs: any[] = []

function makeConfig(id: string): any {
  return {
    id,
    name: `渠道 ${id}`,
    type: 'openai',
    enabled: true,
    url: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: '',
    models: [],
    options: {},
    optionsEnabled: {}
  }
}

function mountSettings(): ReturnType<typeof mount> {
  return mount(ChannelSettings, {
    global: {
      stubs: {
        ChannelConfigSelector: true,
        ChannelCreateDialog: true,
        ChannelBasicSettings: true,
        ChannelContextManagement: true,
        ChannelToolOptions: true,
        ChannelTokenCountMethod: true,
        ChannelProviderOptions: true,
        ChannelCustomBody: true,
        ChannelCustomHeaders: true,
        ChannelAutoRetry: true,
        ConfirmDialog: true,
        teleport: true
      }
    }
  })
}

function listConfigsCallCount(): number {
  return mockSend.mock.calls.filter((call: any[]) => call[0] === 'config.listConfigs').length
}

describe('ChannelSettings 外部批量变更后重拉渠道列表', () => {
  let wrapper: ReturnType<typeof mount>

  beforeEach(() => {
    resetChannelConfigsCache()
    commandHandlers.clear()
    serverConfigs = []
    chatStoreMock.configId = ''
    chatStoreMock.loadCurrentConfig.mockClear()
    mockSend.mockReset()
    mockSend.mockImplementation((type: string, data: any) => {
      switch (type) {
        case 'config.listConfigs':
          return Promise.resolve(serverConfigs.map(c => c.id))
        case 'config.getConfig':
          return Promise.resolve(serverConfigs.find(c => c.id === data.configId) ?? null)
        default:
          return Promise.resolve(undefined)
      }
    })
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  test('空态下收到导入完成通知：重拉列表、渲染渠道表单并自动选中', async () => {
    wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.find('.config-empty').exists()).toBe(true)

    // 模拟导入写入后端 + 后端广播（不带 configId = 外部批量变更）
    serverConfigs = [makeConfig('cfg-imported')]
    commandHandlers.get('channels.configChanged')!({})
    await flushPromises()

    expect(wrapper.find('.config-form').exists()).toBe(true)
    expect(getChannelConfigsCache()?.map(c => c.id)).toEqual(['cfg-imported'])
  })

  test('已有渠道时收到通知：重新请求列表，新渠道进入缓存与视图', async () => {
    serverConfigs = [makeConfig('cfg-1')]
    wrapper = mountSettings()
    await flushPromises()
    const callsAfterMount = listConfigsCallCount()

    serverConfigs = [makeConfig('cfg-1'), makeConfig('cfg-2')]
    commandHandlers.get('channels.configChanged')!({})
    await flushPromises()

    expect(listConfigsCallCount()).toBe(callsAfterMount + 1)
    expect(getChannelConfigsCache()?.map(c => c.id)).toEqual(['cfg-1', 'cfg-2'])
  })

  test('重拉后刷新 chatStore 的当前渠道快照（覆盖导入会改变正在使用的渠道内容）', async () => {
    serverConfigs = [makeConfig('cfg-1')]
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await flushPromises()
    chatStoreMock.loadCurrentConfig.mockClear()

    commandHandlers.get('channels.configChanged')!({})
    await flushPromises()

    expect(chatStoreMock.loadCurrentConfig).toHaveBeenCalledTimes(1)
  })

  test('带 configId 的推送（本组件自身单次编辑）不触发重拉', async () => {
    serverConfigs = [makeConfig('cfg-1')]
    wrapper = mountSettings()
    await flushPromises()
    const callsAfterMount = listConfigsCallCount()

    commandHandlers.get('channels.configChanged')!({ configId: 'cfg-1' })
    await flushPromises()

    expect(listConfigsCallCount()).toBe(callsAfterMount)
  })

  test('卸载后取消订阅', async () => {
    wrapper = mountSettings()
    await flushPromises()
    expect(commandHandlers.has('channels.configChanged')).toBe(true)

    wrapper.unmount()
    wrapper = undefined as unknown as ReturnType<typeof mount>

    expect(commandHandlers.has('channels.configChanged')).toBe(false)
  })
})
