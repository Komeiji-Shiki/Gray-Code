/**
 * SubAgentsSettings 设置页测试——「强制使用当前渠道」全局开关
 *
 * 覆盖：
 * - 全局配置区块（与启用通用 Worker 同级）渲染勾选框及说明文案
 * - 勾选后：subagents.updateGlobalConfig 携带 forceUseCurrentChannel，各子代理渠道/模型下拉被禁用，并显示激活提示
 * - 取消勾选后：下拉恢复可用、激活提示消失
 * - 已开启全局开关时：初始渲染即禁用下拉
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

function mockDefaults(options: { forceUseCurrentChannel?: boolean } = {}) {
  mockSend.mockImplementation((message: string) => {
    switch (message) {
      case MESSAGE_NAMES['subagents.list']:
        return Promise.resolve({
          agents: [AGENT],
          maxConcurrentAgents: 3,
          generalWorkerEnabled: true,
          defaultMaxIterations: 80,
          forceUseCurrentChannel: options.forceUseCurrentChannel === true
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

/** 全局配置区块中的「强制使用当前渠道」勾选框（第 2 个，通用 Worker 之后） */
function forceCheckbox(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.global-config input[type="checkbox"]')[1]
}

function channelSection(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-search-anchor="subagents-channel-model"]')
}

describe('SubAgentsSettings 强制使用当前渠道（全局开关）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('全局配置区块渲染勾选框、文案与说明', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    const globalSection = wrapper.find('.global-config')
    const checkboxes = globalSection.findAll('input[type="checkbox"]')
    // 通用 Worker 与「强制使用当前渠道」同级并列
    expect(checkboxes).toHaveLength(2)
    const force = forceCheckbox(wrapper)
    expect(force.exists()).toBe(true)
    expect((force.element as HTMLInputElement).parentElement?.textContent).toContain('强制所有子代理使用当前渠道')
    expect(wrapper.find('.global-config .checkbox-hint').text()).toContain('统一改用当前会话正在使用的渠道')

    wrapper.unmount()
  })

  test('勾选后：updateGlobalConfig 携带 forceUseCurrentChannel，下拉禁用且显示激活提示', async () => {
    mockDefaults()
    const wrapper = mountSettings()
    await flushPromises()

    await forceCheckbox(wrapper).setValue(true)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.updateGlobalConfig'], {
      forceUseCurrentChannel: true
    })

    const section = channelSection(wrapper)
    expect(section.text()).toContain('此处配置暂不生效')
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })

  test('取消勾选后：下拉恢复可用、激活提示消失', async () => {
    mockDefaults({ forceUseCurrentChannel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const section = channelSection(wrapper)
    expect(section.text()).toContain('此处配置暂不生效')
    let selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(true)

    await forceCheckbox(wrapper).setValue(false)
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith(MESSAGE_NAMES['subagents.updateGlobalConfig'], {
      forceUseCurrentChannel: false
    })
    expect(section.text()).not.toContain('此处配置暂不生效')
    selects = section.findAllComponents({ name: 'CustomSelect' })
    expect(selects[0].props('disabled')).toBe(false)
    expect(selects[1].props('disabled')).toBe(false) // 渠道仍选中（channel_1），模型下拉恢复可用

    wrapper.unmount()
  })

  test('全局开关已开启：初始渲染即禁用渠道/模型下拉并显示激活提示', async () => {
    mockDefaults({ forceUseCurrentChannel: true })
    const wrapper = mountSettings()
    await flushPromises()

    const force = forceCheckbox(wrapper)
    expect((force.element as HTMLInputElement).checked).toBe(true)

    const section = channelSection(wrapper)
    expect(section.text()).toContain('此处配置暂不生效')
    const selects = section.findAllComponents({ name: 'CustomSelect' })
    for (const select of selects) {
      expect(select.props('disabled')).toBe(true)
    }

    wrapper.unmount()
  })
})
