/**
 * SubAgentsSettings 设置页测试——「强制使用当前渠道」勾选框
 *
 * 覆盖：
 * - 渠道与模型区块渲染勾选框及说明文案
 * - 勾选后：subagents.update 携带 forceUseCurrentChannel，渠道/模型下拉被禁用
 * - 取消勾选后：下拉恢复可用
 * - 已配置勾选状态的代理初始渲染即禁用下拉
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, vi, beforeEach } from 'vitest'
import SubAgentsSettings from '../SubAgentsSettings.vue'
import { MESSAGE_NAMES } from '@shared/protocol'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '@/utils/vscode'
const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

const AGENT = {
  type: 'tester',
  name: 'Test Agent',
  description: 'test agent',
  systemPrompt: 'you are a test agent',
  channel: { channelId: 'channel_1' },
  tools: { mode: 'all' },
  maxIterations: 10,
  maxRuntime: 300,
  enabled: true
}

function mockDefaults(channelOverride?: Record<string, unknown>) {
  mockSend.mockImplementation((message: string) => {
    switch (message) {
      case MESSAGE_NAMES['subagents.list']:
        return Promise.resolve({
          agents: [{ ...AGENT, channel: { ...AGENT.channel, ...channelOverride } }],
          maxConcurrentAgents: 3,
          generalWorkerEnabled: true,
          defaultMaxIterations: 80
        })
      case MESSAGE_NAMES['config.listConfigs']:
        return Promise.resolve(['channel_1'])
      case MESSAGE_NAMES['config.getConfig']:
        return Promise.resolve({
          id: 'channel_1',
          name: '渠道 1',
          type: 'openai',
          enabled: true,
          model: 'gpt-4o',
          models: [],
          options: {},
          optionsEnabled: {}
        })
      case MESSAGE_NAMES['tools.getTools']:
        return Promise.resolve({ tools: [] })
      case MESSAGE_NAMES['tools.getMcpTools']:
        return Promise.resolve({ tools: [] })
      case MESSAGE_NAMES['subagents.update']:
        return Promise.resolve({ ok: true })
      default:
        return Promise.resolve(undefined)
    }
  })
}

function mountSettings(): ReturnType<typeof mount> {
  return mount(SubAgentsSettings, {
    global: {
      stubs: {
        CustomSelect: true,
        ConfirmDialog: true,
        teleport: true
      }
    }
  })
}

function channelSection(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-search-anchor="subagents-channel-model"]')
}

describe('SubAgentsSettings 强制使用当前渠道', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('渠道与模型区块渲染勾选框、文案与说明', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    const checkbox = section.find('input[type="checkbox"]')
    expect(checkbox.exists()).toBe(true)
    expect(section.find('.checkbox-text').text()).toBe('强制使用当前渠道')
    expect(section.find('.checkbox-hint').text()).toContain('当前会话')

    wrapper.unmount()
  })

  test('勾选后：subagents.update 携带 forceUseCurrentChannel，渠道/模型下拉被禁用', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    await section.find('input[type="checkbox"]').setValue(true)
    await flushPromises()

    // 保存载荷：channel 对象整体透传，保留原 channelId，附加 forceUseCurrentChannel
    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.update'], {
      type: 'tester',
      updates: {
        channel: { channelId: 'channel_1', forceUseCurrentChannel: true }
      }
    })

    // 勾选后渠道/模型下拉均禁用（运行时忽略其值）
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })

  test('取消勾选后：下拉恢复可用', async () => {
    mockDefaults({ forceUseCurrentChannel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    let selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(true)

    await section.find('input[type="checkbox"]').setValue(false)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.update'], {
      type: 'tester',
      updates: {
        channel: { channelId: 'channel_1', forceUseCurrentChannel: false }
      }
    })

    selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(false)
    expect(selects[1].props('disabled')).toBe(false) // 渠道仍选中（channel_1），模型下拉恢复可用

    wrapper.unmount()
  })

  test('已配置勾选状态的代理：初始渲染即禁用渠道/模型下拉', async () => {
    mockDefaults({ forceUseCurrentChannel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    const checkbox = section.find('input[type="checkbox"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    const selects = section.findAllComponents({ name: 'CustomSelect' })
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })
})
