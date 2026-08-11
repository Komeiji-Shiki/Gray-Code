/**
 * 临时验证测试（S6 拆分后使用，验证后删除）：
 * shared/protocol.ts 正被并发修改（未闭合的 interface），esbuild 无法解析，
 * 故在此 mock @shared/protocol，仅提供 PromptSettings.vue 用到的 MESSAGE_NAMES 键
 * （值与 shared/protocol.ts 中真实定义一致），以验证拆分后的组件行为。
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

vi.mock('@shared/protocol', () => ({
  MESSAGE_NAMES: {
    exportPromptModes: 'exportPromptModes',
    savePromptMode: 'savePromptMode',
    'tools.getTools': 'tools.getTools',
    'tools.getMcpTools': 'tools.getMcpTools',
    getSystemPromptConfig: 'getSystemPromptConfig',
    countSystemPromptTokens: 'countSystemPromptTokens',
    renamePromptMode: 'renamePromptMode',
    deletePromptMode: 'deletePromptMode'
  }
}))

const { sendToExtension } = vi.hoisted(() => ({ sendToExtension: vi.fn() }))

vi.mock('@/utils/vscode', () => ({
  sendToExtension
}))

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

vi.mock('@/stores', () => ({
  useSettingsStore: () => ({ refreshPromptModes: vi.fn() }),
  useChatStore: () => ({ currentConversationId: 'test-conversation' })
}))

import PromptSettings from '../../components/settings/PromptSettings.vue'

/** 构造一个 entries 组装模式、含 assistant 伪造思考内容的系统提示词配置 */
function makeConfig() {
  return {
    currentModeId: 'code',
    modes: {
      code: {
        id: 'code',
        name: 'Code',
        icon: 'symbol-method',
        template: 'template',
        promptAssemblyMode: 'entries',
        dynamicTemplateEnabled: true,
        dynamicTemplate: 'dynamic',
        dynamicContextStrategy: 'single',
        promptEntries: [
          {
            id: 'assistant-entry',
            name: 'Assistant Entry',
            type: 'prompt',
            enabled: true,
            role: 'assistant',
            content: 'assistant content',
            fakeThought: 'fake reasoning trace',
            order: 0
          },
          {
            id: 'chat-history',
            name: 'Chat History',
            type: 'chat_history',
            enabled: true,
            role: 'user',
            content: '',
            fakeThought: '',
            order: 1
          }
        ]
      }
    },
    template: 'template',
    dynamicTemplateEnabled: true,
    dynamicTemplate: 'dynamic',
    dynamicContextStrategy: 'single',
    customPrefix: '',
    customSuffix: ''
  }
}

describe('PromptSettings（S6 拆分后）', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sendToExtension.mockReset()
    sendToExtension.mockImplementation((command: string) => {
      if (command === 'getSystemPromptConfig') return Promise.resolve(makeConfig())
      if (command === 'tools.getTools' || command === 'tools.getMcpTools') return Promise.resolve({ tools: [] })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  test('S6 拆分后锚点/关键 DOM 仍存在（子组件渲染冒烟）', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    // entries 模式下关键锚点
    expect(wrapper.find('[data-search-anchor="prompt-mode-selector"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-assembly"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-entries"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-dynamic-strategy"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-modules"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="tool-policy"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-token-count"]').exists()).toBe(true)

    // 保存按钮（已迁移到 ModeSelectorBar 子组件内）
    expect(wrapper.find('.save-action-btn').exists()).toBe(true)

    // 模式下拉（CustomSelect 仍在 ModeSelectorBar 内）
    expect(wrapper.find('.mode-select-dropdown').exists()).toBe(true)

    // 策略块（DynamicStrategyBlock 子组件）
    expect(wrapper.find('.dynamic-strategy-block').exists()).toBe(true)
    expect(wrapper.find('.dynamic-strategy-warning').exists()).toBe(false)

    // 工具策略区（ToolPolicySection 子组件，inherit 提示）
    expect(wrapper.find('.tool-policy-notice').exists()).toBe(true)
  })

  test('传统模板模式下静态/动态模板编辑区渲染并可保存新内容', async () => {
    sendToExtension.mockImplementation((command: string) => {
      const config = makeConfig()
      config.modes.code.promptAssemblyMode = 'legacy'
      config.modes.code.promptEntries = []
      if (command === 'getSystemPromptConfig') return Promise.resolve(config)
      if (command === 'tools.getTools' || command === 'tools.getMcpTools') return Promise.resolve({ tools: [] })
      return Promise.resolve(undefined)
    })

    wrapper = mount(PromptSettings)
    await flushPromises()

    // legacy 分支的静态/动态编辑区（StaticTemplateSection / DynamicTemplateSection 子组件）
    expect(wrapper.find('[data-search-anchor="static-prompt"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="dynamic-context"]').exists()).toBe(true)
    expect(wrapper.find('.template-textarea').exists()).toBe(true)
    // 内联策略块复用 DynamicStrategyBlock
    expect(wrapper.find('.dynamic-strategy-inline .dynamic-strategy-block').exists()).toBe(true)
    // 动态模板开关（toggle-switch）
    expect(wrapper.find('.toggle-switch input').exists()).toBe(true)

    // 编辑静态模板并保存
    const textareas = wrapper.findAll('textarea.template-textarea')
    expect(textareas.length).toBe(2)
    await textareas[0].setValue('edited static template')
    await wrapper.find('.save-action-btn').trigger('click')
    await flushPromises()

    const saveCall = sendToExtension.mock.calls.find(([command]) => command === 'savePromptMode')
    expect(saveCall).toBeDefined()
    expect(saveCall![1].mode.template).toBe('edited static template')
    // 保存成功 toast（父组件）
    expect(wrapper.find('.save-toast').exists()).toBe(true)
  })

  test('组装方式切换：entries radio 触发父组件切换并进入条目编辑区', async () => {
    sendToExtension.mockImplementation((command: string) => {
      const config = makeConfig()
      config.modes.code.promptAssemblyMode = 'legacy'
      config.modes.code.promptEntries = []
      if (command === 'getSystemPromptConfig') return Promise.resolve(config)
      if (command === 'tools.getTools' || command === 'tools.getMcpTools') return Promise.resolve({ tools: [] })
      return Promise.resolve(undefined)
    })

    wrapper = mount(PromptSettings)
    await flushPromises()

    // 初始为 legacy：无条目编辑区
    expect(wrapper.find('[data-search-anchor="prompt-entries"]').exists()).toBe(false)

    // 点击「预设条目」radio（AssemblyModeSelector 子组件）
    const entriesRadio = wrapper.find('input[type="radio"][value="entries"]')
    expect(entriesRadio.exists()).toBe(true)
    await entriesRadio.setValue(true)
    await flushPromises()

    // 父组件 handlePromptAssemblyModeChange 已生效：进入条目编辑区
    expect(wrapper.find('[data-search-anchor="prompt-entries"]').exists()).toBe(true)
  })
})
