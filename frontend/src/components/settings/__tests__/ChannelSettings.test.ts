/**
 * ChannelSettings 设置页测试——无渠道空态与删除行为
 *
 * 覆盖：
 * - 首次打开无渠道：显示空态引导，不渲染配置表单
 * - 空态下「新建渠道」按钮打开新建对话框
 * - 删除最后一个渠道：后端删除成功 → 空态出现 + chatStore 复位为无渠道
 * - 删除非最后一个渠道：自动选中剩余渠道
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import ChannelSettings from '../ChannelSettings.vue'
import ChannelCreateDialog from '../channelSettings/ChannelCreateDialog.vue'
import { ConfirmDialog } from '../../common'
import { resetChannelConfigsCache } from '@/services/channelConfigCache'

const { chatStoreMock } = vi.hoisted(() => ({
  chatStoreMock: {
    configId: '',
    loadCurrentConfig: vi.fn().mockResolvedValue(undefined),
    setSelectedModelId: vi.fn().mockResolvedValue(undefined),
    setConfigId: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn(),
  // 组件会订阅 channels.configChanged，mock 必须提供该导出
  onExtensionCommand: vi.fn(() => () => {})
}))

vi.mock('@/stores', () => ({
  useChatStore: () => chatStoreMock
}))

import { sendToExtension } from '@/utils/vscode'
const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

function makeConfig(id: string, type = 'openai'): any {
  return {
    id,
    name: `渠道 ${id}`,
    type,
    enabled: true,
    url: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: '',
    models: [],
    options: {},
    optionsEnabled: {}
  }
}

describe('ChannelSettings 无渠道空态', () => {
  let configs: any[]
  let wrapper: ReturnType<typeof mount>

  function mountSettings(): ReturnType<typeof mount> {
    return mount(ChannelSettings, {
      global: {
        stubs: {
          ModelManager: true,
          CustomSelect: true,
          GeminiOptions: true,
          OpenAIOptions: true,
          OpenAIResponsesOptions: true,
          AnthropicOptions: true,
          CustomBodySettings: true,
          CustomHeadersSettings: true,
          ToolOptionsSettings: true,
          TokenCountMethodSettings: true,
          teleport: true
        }
      }
    })
  }

  beforeEach(() => {
    resetChannelConfigsCache() // 重置预加载缓存与在途任务，避免用例之间共享模块状态
    configs = []
    chatStoreMock.configId = ''
    chatStoreMock.setConfigId.mockClear()

    mockSend.mockImplementation((type: string, data: any) => {
      switch (type) {
        case 'config.listConfigs':
          return Promise.resolve(configs.map(c => c.id))
        case 'config.getConfig':
          return Promise.resolve(configs.find(c => c.id === data.configId) ?? null)
        case 'config.deleteConfig':
          configs = configs.filter(c => c.id !== data.configId)
          return Promise.resolve({ success: true })
        default:
          return Promise.resolve(undefined)
      }
    })
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  test('首次打开无任何渠道：显示空态引导，不渲染配置表单', async () => {
    wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.find('.config-empty').exists()).toBe(true)
    expect(wrapper.find('.config-form').exists()).toBe(false)
    expect(wrapper.find('.config-empty-text').text()).toBeTruthy()
  })

  test('初始化选中首个渠道只供查看，不改写聊天渠道和设置草稿', async () => {
    configs = [makeConfig('first')]
    wrapper = mountSettings()
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.config-form').exists()).toBe(true)
    expect(chatStoreMock.setConfigId).not.toHaveBeenCalled()
  })

  test('空态下点击「新建渠道」打开新建对话框', async () => {
    wrapper = mountSettings()
    await flushPromises()

    await wrapper.find('.config-empty .btn.primary').trigger('click')

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
  })

  test('加载失败不伪装成空配置，重试后恢复空态', async () => {
    const normal = mockSend.getMockImplementation()! as (type: string, data: any) => unknown
    let failed = true
    mockSend.mockImplementation((type: string, data: any) => type === 'config.listConfigs' && failed
      ? Promise.reject(new Error('配置读取失败')) : normal(type, data))
    wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.find('.channel-load-error').text()).toContain('配置读取失败')
    expect(wrapper.find('.config-empty').exists()).toBe(false)
    failed = false
    await wrapper.find('.channel-load-error button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.channel-load-error').exists()).toBe(false)
    expect(wrapper.find('.config-empty').exists()).toBe(true)
  })

  test('创建期间不重复提交，失败保留名称并允许再次创建', async () => {
    const normal = mockSend.getMockImplementation()! as (type: string, data: any) => unknown
    let rejectCreation!: (error: Error) => void
    let recovered = false
    mockSend.mockImplementation((type: string, data: any) => {
      if (type !== 'config.createConfig') return normal(type, data)
      if (!recovered) return new Promise((_resolve, reject) => { rejectCreation = reject })
      configs.push({ ...makeConfig('created'), name: data.name })
      return Promise.resolve('created')
    })
    wrapper = mountSettings()
    await flushPromises()
    await wrapper.find('.config-empty .btn.primary').trigger('click')
    await wrapper.find('.config-name-input').setValue('本地服务')
    await wrapper.find('[role="dialog"] .gc-button--primary').trigger('click')
    wrapper.findComponent(ChannelCreateDialog).vm.$emit('create')
    expect(mockSend.mock.calls.filter(([type]) => type === 'config.createConfig')).toHaveLength(1)
    rejectCreation(new Error('暂时无法创建渠道'))
    await flushPromises()
    expect(wrapper.find('[role="dialog"] [role="alert"]').text()).toContain('暂时无法创建渠道')
    expect((wrapper.find('.config-name-input').element as HTMLInputElement).value).toBe('本地服务')
    recovered = true
    await wrapper.find('[role="dialog"] .gc-button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.config-form').exists()).toBe(true)
  })

  test('删除最后一个渠道后回到空态，并复位 chatStore 为无渠道', async () => {
    configs = [makeConfig('cfg-1')]
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.find('.config-form').exists()).toBe(true)

    await wrapper.find('.icon-btn.danger').trigger('click')
    await flushPromises()

    const dialog = wrapper.findComponent(ConfirmDialog)
    expect(dialog.exists()).toBe(true)
    dialog.vm.$emit('confirm')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('config.deleteConfig', { configId: 'cfg-1' })
    expect(wrapper.find('.config-empty').exists()).toBe(true)
    expect(wrapper.find('.config-form').exists()).toBe(false)
    expect(chatStoreMock.setConfigId).toHaveBeenCalledWith('')
  })

  test('删除非最后一个渠道：自动选中剩余渠道，不清空 chatStore 选择', async () => {
    configs = [makeConfig('cfg-1'), makeConfig('cfg-2')]
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await flushPromises()

    await wrapper.find('.icon-btn.danger').trigger('click')
    await flushPromises()
    wrapper.findComponent(ConfirmDialog).vm.$emit('confirm')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('config.deleteConfig', { configId: 'cfg-1' })
    expect(wrapper.find('.config-form').exists()).toBe(true)
    expect(chatStoreMock.setConfigId).not.toHaveBeenCalledWith('')
    await nextTick()
  })
})
