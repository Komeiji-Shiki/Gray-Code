/**
 * ChannelSettings - url/apiKey 防抖保存竞态测试
 *
 * 覆盖：
 * - 同一防抖窗口内连续输入 url 与 apiKey：聚合为一次 config.updateConfig 提交
 *   （两个字段同时落盘，后输入字段不再覆盖先输入字段）
 * - 点击「获取模型」：prepareModelFetch 先 flush 未提交的 url/apiKey 编辑
 *   （无需等待 300ms 防抖），落盘完成后才打开模型选择对话框，
 *   避免 models.getModels 只凭 configId 读取到后端持久化的旧配置
 * - 防抖提交后继续输入：后续只提交最新聚合补丁，不重复携带旧字段
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import ChannelSettings from '../ChannelSettings.vue'
import ModelSelectionDialog from '../ModelSelectionDialog.vue'
import { resetChannelConfigsCache, setChannelConfigsCache } from '@/services/channelConfigCache'

const { chatStoreMock } = vi.hoisted(() => ({
  chatStoreMock: {
    configId: '',
    loadCurrentConfig: vi.fn().mockResolvedValue(undefined),
    setSelectedModelId: vi.fn().mockResolvedValue(undefined),
    setConfigId: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
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

function updateConfigCalls(): any[][] {
  return mockSend.mock.calls.filter((call: any[]) => call[0] === 'config.updateConfig')
}

describe('ChannelSettings url/apiKey 防抖保存', () => {
  let wrapper: ReturnType<typeof mount>

  function mountSettings(): ReturnType<typeof mount> {
    return mount(ChannelSettings, {
      global: {
        stubs: {
          ModelSelectionDialog: true,
          ConfirmDialog: true,
          CustomScrollbar: true,
          CustomSelect: true,
          teleport: true
        }
      }
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetChannelConfigsCache()
    chatStoreMock.configId = ''
    chatStoreMock.loadCurrentConfig.mockClear()
    mockSend.mockClear()
    mockSend.mockResolvedValue(undefined)
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('同一防抖窗口内输入 url 与 apiKey：聚合为一次 updateConfig 提交', async () => {
    setChannelConfigsCache([makeConfig('cfg-1')])
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    await wrapper.find('[data-search-anchor="api-url"] input').setValue('https://new.example.com/v1')
    await wrapper.find('[data-search-anchor="api-key"] input').setValue('new-key')

    // 防抖窗口内尚未提交
    expect(updateConfigCalls()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(300)

    const calls = updateConfigCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({
      configId: 'cfg-1',
      updates: { url: 'https://new.example.com/v1', apiKey: 'new-key' }
    })
  })

  test('点击「获取模型」：先 flush 未提交的 url/apiKey 编辑，落盘后才打开模型对话框', async () => {
    setChannelConfigsCache([makeConfig('cfg-1')])
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    await wrapper.find('[data-search-anchor="api-url"] input').setValue('https://new.example.com/v1')
    await wrapper.find('[data-search-anchor="api-key"] input').setValue('new-key')
    expect(updateConfigCalls()).toHaveLength(0)

    let resolveSave!: (value?: unknown) => void
    mockSend.mockImplementation((messageName: string) => {
      if (messageName === 'config.updateConfig') {
        return new Promise(resolve => { resolveSave = resolve })
      }
      return Promise.resolve(undefined)
    })

    // 打开模型对话框：不等待 300ms 防抖，立即触发 flush；持久化尚未完成时不能打开。
    await wrapper.find('.fetch-btn').trigger('click')
    await Promise.resolve()

    const calls = updateConfigCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({
      configId: 'cfg-1',
      updates: { url: 'https://new.example.com/v1', apiKey: 'new-key' }
    })
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(false)

    resolveSave(undefined)
    await flushPromises()

    // 后端确认保存完成后，模型对话框才允许显示。
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(true)
  })

  test('保存失败后保留聚合补丁，下一次获取模型会重试而不是永久阻塞', async () => {
    setChannelConfigsCache([makeConfig('cfg-1')])
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockSend.mockRejectedValueOnce(new Error('write failed'))
    await wrapper.find('[data-search-anchor="api-url"] input').setValue('https://retry.example.com/v1')
    await wrapper.find('[data-search-anchor="api-key"] input').setValue('retry-key')
    await vi.advanceTimersByTimeAsync(300)
    expect(updateConfigCalls()).toHaveLength(1)

    // 首次失败的补丁已放回；点击后重新提交，成功后才打开对话框。
    await wrapper.find('.fetch-btn').trigger('click')
    await flushPromises()

    const calls = updateConfigCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toEqual({
      configId: 'cfg-1',
      updates: { url: 'https://retry.example.com/v1', apiKey: 'retry-key' }
    })
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(true)
  })

  test('保存途中继续输入时，获取模型会等最新补丁也落盘', async () => {
    setChannelConfigsCache([makeConfig('cfg-1')])
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    let resolveFirstSave!: (value?: unknown) => void
    let updateCount = 0
    mockSend.mockImplementation((messageName: string) => {
      if (messageName !== 'config.updateConfig') return Promise.resolve(undefined)
      updateCount += 1
      if (updateCount === 1) {
        return new Promise(resolve => { resolveFirstSave = resolve })
      }
      return Promise.resolve(undefined)
    })

    await wrapper.find('[data-search-anchor="api-key"] input').setValue('key-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(updateConfigCalls()).toHaveLength(1)

    await wrapper.find('[data-search-anchor="api-key"] input').setValue('key-2')
    await wrapper.find('.fetch-btn').trigger('click')
    await Promise.resolve()
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(false)
    expect(updateConfigCalls()).toHaveLength(1)

    resolveFirstSave(undefined)
    await flushPromises()

    const calls = updateConfigCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1][1].updates).toEqual({ apiKey: 'key-2' })
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(true)
  })

  test('防抖提交后继续输入：只提交最新聚合补丁，不重复携带旧字段', async () => {
    setChannelConfigsCache([makeConfig('cfg-1')])
    chatStoreMock.configId = 'cfg-1'
    wrapper = mountSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    // 第一轮：url + apiKey 聚合提交
    await wrapper.find('[data-search-anchor="api-url"] input').setValue('https://a.example.com/v1')
    await wrapper.find('[data-search-anchor="api-key"] input').setValue('key-1')
    await vi.advanceTimersByTimeAsync(300)

    // 第二轮：只改 apiKey，只提交 apiKey（不携带旧 url）
    await wrapper.find('[data-search-anchor="api-key"] input').setValue('key-2')
    await vi.advanceTimersByTimeAsync(300)

    const calls = updateConfigCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0][1].updates).toEqual({ url: 'https://a.example.com/v1', apiKey: 'key-1' })
    expect(calls[1][1].updates).toEqual({ apiKey: 'key-2' })
  })
})
