/**
 * InputArea 发送失败恢复回归测试。
 *
 * 背景（fix/bugfix-scan-round）：
 * 直接发送是异步的——InputArea 同步 emit('send') 后立即清空输入，而 App.vue 要
 * await sendMessage 才知道结果。此前发送失败（忙时投递拒绝带附件消息 / IPC 异常）
 * 时只恢复附件、正文从输入框静默消失。
 *
 * 修复：emit('send') 增加第 4 个参数 onResult(ok)，父组件在发送结果确定后回调；
 * InputArea 备份发送前节点，失败且用户未开始新输入时恢复 editorNodes + inputValue。
 *
 * 本测试用「与 App.vue handleSend 同构」的父组件包装 InputArea，覆盖失败恢复与成功清空。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import InputArea from '../../components/input/InputArea.vue'
import type { Attachment } from '../../types'
import type { EditorNode } from '../../types/editorNode'

const runtime = vi.hoisted(() => ({
  chatStore: undefined as any,
  settingsStore: undefined as any,
  sendToExtension: vi.fn().mockResolvedValue({ success: true }),
  showNotification: vi.fn().mockResolvedValue(undefined),
  onExtensionCommand: vi.fn((_command: string, _handler: (data: any) => void) => () => {}),
  config: {
    listConfigIds: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn().mockResolvedValue(null),
    getPromptModes: vi.fn().mockResolvedValue({ modes: [] })
  },
  context: {
    previewAttachment: vi.fn().mockResolvedValue(undefined),
    readWorkspaceFileForInput: vi.fn().mockResolvedValue(null),
    showContextContent: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../stores', () => ({
  useChatStore: () => runtime.chatStore,
  useSettingsStore: () => runtime.settingsStore
}))

vi.mock('../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  showNotification: runtime.showNotification,
  onExtensionCommand: runtime.onExtensionCommand
}))

vi.mock('../../services/config', () => ({
  listConfigIds: runtime.config.listConfigIds,
  getConfig: runtime.config.getConfig,
  getPromptModes: runtime.config.getPromptModes
}))

vi.mock('../../services/context', () => ({
  previewAttachment: runtime.context.previewAttachment,
  readWorkspaceFileForInput: runtime.context.readWorkspaceFileForInput,
  showContextContent: runtime.context.showContextContent
}))

vi.mock('../../i18n', async (importOriginal) => {
  // 保留真实模块的其余导出（t / setLanguage 等被 import 图中的其他模块顶层使用），
  // 仅替换 useI18n 为测试桩
  const actual = await importOriginal<typeof import('../../i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

/** SendButton 桩：转发 click，用于触发 InputArea.handleSend */
const SendButtonStub = {
  name: 'SendButton',
  props: ['disabled', 'loading'],
  emits: ['click', 'preserve-dynamic-context-click', 'cancel'],
  template: '<button class="send-button-stub" @click="$emit(\'click\')"></button>'
}

const stubs = {
  InputBox: true,
  FilePickerPanel: true,
  SendButton: SendButtonStub,
  MessageQueue: true,
  InputAttachments: true,
  PinnedFilesWidget: true,
  SkillsWidget: true,
  TpsBar: true,
  BranchTreePanel: true,
  InputSelectorBar: true,
  IconButton: { name: 'IconButton', props: ['icon', 'size', 'disabled', 'loading'], template: '<button><slot /></button>' },
  Tooltip: { name: 'Tooltip', template: '<span><slot /></span>' }
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    name: 'a.png',
    type: 'image',
    size: 10,
    mimeType: 'image/png',
    data: 'base64data',
    metadata: {},
    ...overrides
  }
}

function makeTextNodes(text: string): EditorNode[] {
  return [{ type: 'text', text }]
}

/** 与 App.vue handleSend 同构的父组件：先清附件，失败时恢复附件并回调 onResult */
function mountWithParent(sendMessage: (content: string, attachments: Attachment[], options?: any) => Promise<boolean>) {
  return mount({
    components: { InputArea },
    setup() {
      const attachments = ref<Attachment[]>([])
      async function handleSend(
        content: string,
        messageAttachments: Attachment[],
        options?: any,
        onResult?: (ok: boolean) => void
      ) {
        attachments.value = []
        let sent = false
        try {
          sent = await sendMessage(content, messageAttachments, options)
        } catch (err) {
          console.error('发送失败:', err)
        }
        if (!sent && messageAttachments.length > 0) {
          attachments.value.push(...messageAttachments)
        }
        onResult?.(sent)
      }
      return { attachments, handleSend }
    },
    template: '<InputArea :attachments="attachments" @send="handleSend" />'
  }, {
    global: { stubs }
  })
}

describe('InputArea 发送失败恢复', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    runtime.chatStore = reactive({
      editorNodes: [] as EditorNode[],
      inputValue: '',
      isWaitingForResponse: false,
      messageQueue: [] as any[],
      hasPendingToolConfirmation: false,
      currentConfig: { model: 'test-model' },
      selectedModelId: 'test-model',
      configId: 'cfg_1',
      currentPromptModeId: 'code',
      autoSummaryStatus: null,
      tokenUsagePercent: 0,
      usedTokens: 0,
      maxContextTokens: 100,
      currentConversationId: null,
      visionSplitChecked: true,
      setVisionSplitChecked(v: boolean) { this.visionSplitChecked = v },
      setEditorNodes(nodes: EditorNode[]) { this.editorNodes = nodes },
      setInputValue(v: string) { this.inputValue = v },
      clearInputValue() { this.inputValue = '' },
      enqueueMessage: vi.fn(),
      setCurrentPromptModeId: vi.fn(),
      createManualCheckpoint: vi.fn()
    })
    runtime.settingsStore = reactive({
      promptModesVersion: 0,
      tpsBarEnabled: false,
      showSettings: vi.fn()
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  test('直接发送失败：正文（editorNodes + inputValue）与附件均恢复', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false)
    wrapper = mountWithParent(sendMessage)
    await nextTick()

    const initialNodes: EditorNode[] = [
      { type: 'text', text: '帮我读一下文件' },
      {
        type: 'context',
        context: {
          id: 'ctx-1',
          type: 'file',
          title: 'a.ts',
          content: 'file content',
          filePath: 'a.ts',
          isTextContent: true,
          enabled: true,
          addedAt: 1
        }
      }
    ]
    runtime.chatStore.editorNodes = initialNodes
    await nextTick()
    ;(wrapper.vm as any).attachments = [makeAttachment()]
    await nextTick()

     await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()
    await nextTick()

    // 正文恢复：editorNodes 恢复为发送前节点（含上下文徽章），inputValue 由反向同步 watch 恢复
    expect(runtime.chatStore.editorNodes).toEqual(initialNodes)
    expect(runtime.chatStore.inputValue).toBe('帮我读一下文件')
    // 附件恢复（父组件失败分支 push 回输入区）
    expect((wrapper.vm as any).attachments).toEqual([makeAttachment()])
    // sendMessage 收到的是序列化后的完整内容（文本 + <lim-context> 徽章）与附件
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [content, attachments] = sendMessage.mock.calls[0] as [string, Attachment[], any]
    expect(content).toContain('帮我读一下文件')
    expect(content).toContain('<lim-context')
    expect(attachments).toEqual([makeAttachment()])
  })

  test('直接发送成功：输入清空且不恢复（正常路径不变）', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true)
    wrapper = mountWithParent(sendMessage)
    await nextTick()

    runtime.chatStore.editorNodes = makeTextNodes('hello')
    await nextTick()
    ;(wrapper.vm as any).attachments = [makeAttachment()]
    await nextTick()

    await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()
    await nextTick()

    expect(runtime.chatStore.editorNodes).toEqual([])
    expect(runtime.chatStore.inputValue).toBe('')
    // 成功路径不恢复附件（保持已清除状态）
    expect((wrapper.vm as any).attachments).toEqual([])
  })

  test('发送失败但用户已开始输入新内容：不覆盖用户新输入', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false)
    wrapper = mountWithParent(sendMessage)
    await nextTick()

    runtime.chatStore.editorNodes = makeTextNodes('old message')
    await nextTick()

    await wrapper.find('.send-button-stub').trigger('click')
    // 发送结果返回前用户已输入新内容（editorNodes 非空）
    runtime.chatStore.editorNodes = makeTextNodes('new message')
    await flushPromises()
    await nextTick()

    expect(runtime.chatStore.editorNodes).toEqual(makeTextNodes('new message'))
  })

  test('忙碌时走入队路径：不携带 onResult 回调，输入照常清空', async () => {
    wrapper = mountWithParent(vi.fn().mockResolvedValue(true))
    await nextTick()

    runtime.chatStore.isWaitingForResponse = true
    runtime.chatStore.editorNodes = makeTextNodes('queued text')
    await nextTick()

    await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()
    await nextTick()

    expect(runtime.chatStore.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(runtime.chatStore.editorNodes).toEqual([])
    expect(runtime.chatStore.inputValue).toBe('')
  })

  test('直接发送事件携带 onResult 回调（第 4 参数）', async () => {
    // 直接挂载（无父级 @send 消费），检查 emit 载荷
    const direct = mount(InputArea, {
      props: { attachments: [] },
      global: { stubs }
    })
    await nextTick()
    runtime.chatStore.editorNodes = makeTextNodes('hi')
    await nextTick()

    await direct.find('.send-button-stub').trigger('click')

    const sendEvents = direct.emitted('send')
    expect(sendEvents).toBeTruthy()
    const last = sendEvents![sendEvents!.length - 1]
    expect(last[0]).toContain('hi')
    expect(typeof last[3]).toBe('function')
    direct.unmount()
  })

  test('监听 channels.configChanged：设置面板变更后重新加载渠道配置（新增模型无需重启扩展）', async () => {
    wrapper = mountWithParent(vi.fn().mockResolvedValue(true))
    await nextTick()
    await flushPromises()

    // 挂载时已注册 channels.configChanged 监听（且仅注册一次）
    const registered = vi.mocked(runtime.onExtensionCommand).mock.calls.filter(c => c[0] === 'channels.configChanged')
    expect(registered).toHaveLength(1)
    const handler = registered[0][1] as () => void

    // 首次挂载拉取过一次配置
    expect(runtime.config.listConfigIds).toHaveBeenCalledTimes(1)

    // 模拟设置面板添加模型后后端推送刷新命令
    handler()
    await flushPromises()

    // 输入区重新拉取渠道配置，模型下拉框数据源随之更新
    expect(runtime.config.listConfigIds).toHaveBeenCalledTimes(2)
  })
})

describe('InputArea DeepSeek Vision 拆分复选框', () => {
  let wrapper: VueWrapper | undefined

  const visionConfig = {
    id: 'cfg_1',
    name: 'DeepSeek Vision',
    type: 'openai',
    enabled: true,
    model: 'deepseek-v4-flash-vision-exp',
    deepSeekVisionEnabled: true
  }

  async function mountWithVisionConfig(attachments: Attachment[], overrides: Record<string, unknown> = {}) {
    runtime.config.listConfigIds.mockResolvedValue(['cfg_1'] as any)
    runtime.config.getConfig.mockResolvedValue({ ...visionConfig, ...overrides } as any)
    runtime.chatStore.configId = 'cfg_1'

    const mounted = mount(InputArea, {
      props: { attachments },
      global: { stubs }
    })
    await nextTick()
    await flushPromises()
    return mounted
  }

  beforeEach(() => {
    runtime.chatStore = reactive({
      editorNodes: [] as EditorNode[],
      inputValue: '',
      isWaitingForResponse: false,
      messageQueue: [] as any[],
      hasPendingToolConfirmation: false,
      currentConfig: { model: 'deepseek-v4-flash-vision-exp' },
      selectedModelId: 'deepseek-v4-flash-vision-exp',
      configId: 'cfg_1',
      currentPromptModeId: 'code',
      autoSummaryStatus: null,
      tokenUsagePercent: 0,
      usedTokens: 0,
      maxContextTokens: 100,
      currentConversationId: null,
      visionSplitChecked: true,
      setVisionSplitChecked(v: boolean) { this.visionSplitChecked = v },
      setEditorNodes(nodes: EditorNode[]) { this.editorNodes = nodes },
      setInputValue(v: string) { this.inputValue = v },
      clearInputValue() { this.inputValue = '' },
      enqueueMessage: vi.fn(),
      setCurrentPromptModeId: vi.fn(),
      createManualCheckpoint: vi.fn()
    })
    runtime.settingsStore = reactive({
      promptModesVersion: 0,
      tpsBarEnabled: false,
      showSettings: vi.fn()
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  test('有图片附件 + Vision 预处理开启 + Vision 模型：复选框显示且默认勾选（拆分）', async () => {
    wrapper = await mountWithVisionConfig([makeAttachment()])

    const toggle = wrapper.find('.vision-split-toggle')
    expect(toggle.exists()).toBe(true)
    expect((toggle.find('input').element as HTMLInputElement).checked).toBe(true)

    // 发送时 options 携带 deepSeekVisionTileSplit: true
    runtime.chatStore.editorNodes = makeTextNodes('hi')
    await nextTick()
    await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()
    const emitted = wrapper.emitted('send')
    expect(emitted).toBeTruthy()
    const last = emitted![emitted!.length - 1]
    expect(last[2]).toEqual({ deepSeekVisionTileSplit: true })
  })

  test('取消勾选：发送时携带 deepSeekVisionTileSplit: false（压缩模式）', async () => {
    wrapper = await mountWithVisionConfig([makeAttachment()])
    runtime.chatStore.editorNodes = makeTextNodes('hi')
    await nextTick()

    const checkbox = wrapper.find('.vision-split-toggle input')
    await checkbox.setValue(false)
    await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()

    const emitted = wrapper.emitted('send')
    const last = emitted![emitted!.length - 1]
    expect(last[2]).toEqual({ deepSeekVisionTileSplit: false })
  })

  test('无图片附件：复选框不显示', async () => {
    wrapper = await mountWithVisionConfig([])
    expect(wrapper.find('.vision-split-toggle').exists()).toBe(false)
  })

  test('纯文本续轮在 Vision 渠道仍携带 store 模式，供历史与工具续跑继承', async () => {
    runtime.chatStore.visionSplitChecked = false
    wrapper = await mountWithVisionConfig([])
    runtime.chatStore.editorNodes = makeTextNodes('text follow-up')
    await nextTick()

    await wrapper.find('.send-button-stub').trigger('click')
    await flushPromises()

    const emitted = wrapper.emitted('send')
    expect(emitted).toBeTruthy()
    expect(emitted![emitted!.length - 1][2]).toEqual({ deepSeekVisionTileSplit: false })
  })

  test('图片附件但 deepSeekVisionEnabled 关闭：复选框不显示', async () => {
    wrapper = await mountWithVisionConfig([makeAttachment()], { deepSeekVisionEnabled: false })
    expect(wrapper.find('.vision-split-toggle').exists()).toBe(false)
  })

  test('store 偏好为 false（用户此前取消勾选）：复选框默认不勾选且发送携带 false（编辑/重试保持一致）', async () => {
    runtime.chatStore.visionSplitChecked = false
    wrapper = await mountWithVisionConfig([makeAttachment()])

    const checkbox = wrapper.find('.vision-split-toggle input') as any
    expect(checkbox.element.checked).toBe(false)

    runtime.chatStore.editorNodes = makeTextNodes('hi')
    await nextTick()
    await wrapper.find('.send-button-stub').trigger('click')

    const emitted = wrapper.emitted('send')
    expect(emitted).toBeTruthy()
    const last = emitted![emitted!.length - 1]
    expect(last[2]).toEqual({ deepSeekVisionTileSplit: false })
  })

  test('图片附件 + 预处理开启但模型非 Vision：复选框不显示', async () => {
    wrapper = await mountWithVisionConfig([makeAttachment()], { model: 'deepseek-chat' })
    // 当前模型来自 chatStore.selectedModelId，保持 vision 时也覆盖为 chat
    runtime.chatStore.selectedModelId = 'deepseek-chat'
    await nextTick()
    expect(wrapper.find('.vision-split-toggle').exists()).toBe(false)
  })

  test('token ring is keyboard focusable and exposes current usage as one accessible label', async () => {
    wrapper = mountWithParent(async () => true)
    await nextTick()

    const tokenRing = wrapper.get('.token-ring-wrapper')
    expect(tokenRing.attributes('role')).toBe('img')
    expect(tokenRing.attributes('tabindex')).toBe('0')
    expect(tokenRing.attributes('aria-label')).toContain('components.input.tokenUsage: 0.0%')
    expect(tokenRing.attributes('aria-label')).toContain('0 / 100')
  })
})
