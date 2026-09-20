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
import ModeSelectorBar from '../../components/settings/prompt/ModeSelectorBar.vue'
import ImportModesDialog from '../../components/settings/prompt/ImportModesDialog.vue'

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

describe('PromptSettings fakeThought 持久化', () => {
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

  test.each(['map', 'array', 'legacy-settings', 'desktop-settings'])('导入 %s 保留旧预设正文并选中新增预设', async format => {
    wrapper = mount(PromptSettings); await flushPromises()
    const mode = { ...makeConfig().modes.code, id: 'legacy', name: '旧预设', promptEntries: [
      { id: 'legacy-body', name: '正文', type: 'prompt', role: 'system', enabled: true, content: '来自旧预设的实际正文', order: 0 }
    ] }
    const prompt = { modes: { legacy: mode } }
    const payload = format === 'map' ? prompt : format === 'array' ? { modes: [mode] }
      : format === 'legacy-settings' ? { globalSettings: { language: 'zh-CN' }, vscodeSettings: { 'graycode.toolsConfig': { system_prompt: prompt } } }
      : { format: 'graycode-platform', features: { toolsConfig: { system_prompt: prompt } } }
    wrapper.findComponent(ModeSelectorBar).vm.$emit('import'); await flushPromises()
    const dialog = wrapper.findComponent(ImportModesDialog)
    dialog.vm.$emit('update:payloadText', JSON.stringify(payload)); await flushPromises()
    dialog.vm.$emit('confirm'); await flushPromises()
    const saved = sendToExtension.mock.calls.find(([name]) => name === 'savePromptMode')?.[1].mode
    expect(saved).toMatchObject({ name: '旧预设', promptEntries: expect.arrayContaining([
      expect.objectContaining({ content: '来自旧预设的实际正文' })
    ]) })
    expect(wrapper.findComponent(ModeSelectorBar).props('selectedModeId')).toBe(saved.id)
    expect(wrapper.findComponent(ImportModesDialog).exists()).toBe(false)
  })

  test('不支持的 JSON 显示错误，不生成默认预设', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      wrapper = mount(PromptSettings); await flushPromises()
      wrapper.findComponent(ModeSelectorBar).vm.$emit('import'); await flushPromises()
      const dialog = wrapper.findComponent(ImportModesDialog)
      dialog.vm.$emit('update:payloadText', JSON.stringify({ unrelated: 'not a preset' })); await flushPromises()
      dialog.vm.$emit('confirm'); await flushPromises()
      expect(sendToExtension.mock.calls.filter(([name]) => name === 'savePromptMode')).toEqual([])
      expect(dialog.props('errorMessage')).toBe('components.settings.promptSettings.modes.importInvalid')
    } finally { error.mockRestore() }
  })

  test('加载配置时把 fakeThought 回填到 assistant 条目的伪造思考输入框', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    const textarea = wrapper.find('.fake-thought-textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('fake reasoning trace')
  })

  test('保存模式时 fakeThought 随 promptEntries 一起提交，不丢失', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    const textarea = wrapper.find('.fake-thought-textarea')
    await textarea.setValue('updated fake reasoning')
    await wrapper.find('.save-action-btn').trigger('click')
    await flushPromises()

    const saveCall = sendToExtension.mock.calls.find(([command]) => command === 'savePromptMode')
    expect(saveCall).toBeDefined()
    const mode = saveCall![1].mode
    const assistantEntry = mode.promptEntries.find((entry: { role: string }) => entry.role === 'assistant')
    expect(assistantEntry.fakeThought).toBe('updated fake reasoning')
  })

  test('修改 fakeThought 后保存，提交的是最新内容', async () => {
    wrapper = mount(PromptSettings)
    await flushPromises()

    const textarea = wrapper.find('.fake-thought-textarea')
    await textarea.setValue('another fake reasoning')

    const saveCallBefore = sendToExtension.mock.calls.filter(([command]) => command === 'savePromptMode')
    expect(saveCallBefore).toHaveLength(0)

    await wrapper.find('.save-action-btn').trigger('click')
    await flushPromises()

    const saveCall = sendToExtension.mock.calls.find(([command]) => command === 'savePromptMode')
    expect(saveCall).toBeDefined()
    const mode = saveCall![1].mode
    const assistantEntry = mode.promptEntries.find((entry: { role: string }) => entry.role === 'assistant')
    expect(assistantEntry.fakeThought).toBe('another fake reasoning')
  })
})
