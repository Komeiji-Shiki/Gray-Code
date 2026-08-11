/**
 * SubAgentsSettings 设置页测试——「与当前模型同步」逐代理开关
 *
 * 覆盖：
 * - 渠道/模型区块渲染勾选框及说明文案
 * - 勾选后：subagents.update 携带 channel.syncWithCurrentModel=true，渠道/模型下拉被禁用，并显示激活提示
 * - 取消勾选后：下拉恢复可用、激活提示消失
 * - 已开启同步时：初始渲染即禁用下拉
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

function makeAgent(options: { syncWithCurrentModel?: boolean; channelId?: string } = {}) {
  const channel: { channelId: string; modelId?: string; syncWithCurrentModel?: boolean } = { channelId: options.channelId ?? 'channel_1' }
  if (options.syncWithCurrentModel !== undefined) {
    channel.syncWithCurrentModel = options.syncWithCurrentModel
  }
  return {
    type: 'tester',
    name: 'Test Agent',
    description: 'test agent',
    systemPrompt: 'you are a test agent',
    channel,
    tools: { mode: 'all' },
    maxIterations: 10,
    maxRuntime: 300,
    enabled: true
  }
}

function mockDefaults(options: { syncWithCurrentModel?: boolean; channelId?: string } = {}) {
  mockSend.mockImplementation((message: string) => {
    switch (message) {
      case MESSAGE_NAMES['subagents.list']:
        return Promise.resolve({
          agents: [makeAgent(options)],
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
      case MESSAGE_NAMES['subagents.updateGlobalConfig']:
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

/** 渠道/模型区块中的「与当前模型同步」勾选框 */
function syncCheckbox(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-search-anchor="subagents-channel-model"] input[type="checkbox"]')
}

describe('SubAgentsSettings 与当前模型同步（逐代理开关）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('渠道/模型区块渲染勾选框、文案与说明', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    expect(section.text()).toContain('与当前模型同步')
    expect(section.text()).toContain('统一使用当前会话正在使用的渠道与模型')
    const sync = syncCheckbox(wrapper)
    expect(sync.exists()).toBe(true)
    expect((sync.element as HTMLInputElement).checked).toBe(false)

    wrapper.unmount()
  })

  test('勾选后：subagents.update 携带 channel.syncWithCurrentModel，下拉禁用且显示激活提示', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    await syncCheckbox(wrapper).setValue(true)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.update'], {
      type: 'tester',
      updates: {
        channel: { channelId: 'channel_1', syncWithCurrentModel: true }
      }
    })

    const section = channelSection(wrapper)
    expect(section.text()).toContain('以下渠道/模型配置暂不生效')
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })

  test('取消勾选后：下拉恢复可用、激活提示消失', async () => {
    mockDefaults({ syncWithCurrentModel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    expect(section.text()).toContain('以下渠道/模型配置暂不生效')
    let selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(true)

    await syncCheckbox(wrapper).setValue(false)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.update'], {
      type: 'tester',
      updates: {
        channel: { channelId: 'channel_1', syncWithCurrentModel: false }
      }
    })
    expect(section.text()).not.toContain('以下渠道/模型配置暂不生效')
    selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(false)
    expect(selects[1].props('disabled')).toBe(false) // 渠道仍选中（channel_1），模型下拉恢复可用

    wrapper.unmount()
  })

  test('已开启同步：初始渲染即禁用渠道/模型下拉并显示激活提示', async () => {
    mockDefaults({ syncWithCurrentModel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const sync = syncCheckbox(wrapper)
    expect((sync.element as HTMLInputElement).checked).toBe(true)

    const section = channelSection(wrapper)
    expect(section.text()).toContain('以下渠道/模型配置暂不生效')
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })

  test('代理渠道不在已配置列表时：模型下拉禁用、渠道下拉仍可用', async () => {
    // channelId 指向一个不存在的渠道（不在 config.listConfigs 返回的 channel_1 中）
    mockDefaults({ channelId: 'ghost_channel' })
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects).toHaveLength(2)
    // 渠道下拉可交互（同步未勾选、无其它禁用条件）
    expect(selects[0].props('disabled')).toBe(false)
    // 模型下拉因当前选中的渠道不存在（selectedChannel 为 undefined）而禁用
    expect(selects[1].props('disabled')).toBe(true)

    wrapper.unmount()
  })
})
