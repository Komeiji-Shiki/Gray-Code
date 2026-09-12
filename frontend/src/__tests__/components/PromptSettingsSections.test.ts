/**
 * 提示词设置页面回归：验证实际条目编辑入口、保存与历史插入点保留。
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

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

describe('PromptSettings 提示词条目设置', () => {
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

  test('模式、条目、变量、工具策略与 Token 计数入口完整', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    // entries 模式下关键锚点
    expect(wrapper.find('[data-search-anchor="prompt-mode-selector"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-entries"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-modules"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="tool-policy"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-anchor="prompt-token-count"]').exists()).toBe(true)

    // 保存按钮（已迁移到 ModeSelectorBar 子组件内）
    expect(wrapper.find('.save-action-btn').exists()).toBe(true)

    // 模式下拉（CustomSelect 仍在 ModeSelectorBar 内）
    expect(wrapper.find('.mode-select-dropdown').exists()).toBe(true)

    // 工具策略区（ToolPolicySection 子组件，inherit 提示）
    expect(wrapper.find('.tool-policy-notice').exists()).toBe(true)
  })

  test('条目正文和预置思考可编辑保存，历史插入点保持不变', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    await wrapper.get('.entry-content-textarea').setValue('edited assistant entry')
    await wrapper.get('.fake-thought-textarea').setValue('edited preset thought')
    await wrapper.find('.save-action-btn').trigger('click')
    await flushPromises()

    const saveCall = sendToExtension.mock.calls.find(([command]) => command === 'savePromptMode')
    expect(saveCall).toBeDefined()
    expect(saveCall![1].mode.promptAssemblyMode).toBe('entries')
    expect(saveCall![1].mode.promptEntries).toEqual([
      expect.objectContaining({ id: 'assistant-entry', content: 'edited assistant entry', fakeThought: 'edited preset thought', role: 'assistant', enabled: true }),
      expect.objectContaining({ id: 'chat-history', type: 'chat_history', enabled: true, order: 1 })
    ])
    // 保存成功 toast（父组件）
    expect(wrapper.find('.save-toast').exists()).toBe(true)
  })

  test('新增条目从完整页面写回模式，保留已有条目与唯一历史插入点', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('新增条目'))!.trigger('click')
    await flushPromises()

    await wrapper.findAll('.entry-name-input').at(-1)!.setValue('新增约束')
    await wrapper.findAll('.entry-content-textarea').at(-1)!.setValue('保留已有用户输入')
    await wrapper.get('.save-action-btn').trigger('click')
    await flushPromises()
    const saved = sendToExtension.mock.calls.find(([command]) => command === 'savePromptMode')![1].mode.promptEntries
    expect(saved).toHaveLength(3)
    expect(saved[0]).toMatchObject({ id: 'assistant-entry', content: 'assistant content', fakeThought: 'fake reasoning trace' })
    expect(saved.filter((entry: any) => entry.type === 'chat_history')).toHaveLength(1)
    expect(saved[2]).toMatchObject({ name: '新增约束', content: '保留已有用户输入', order: 2 })
  })
})
