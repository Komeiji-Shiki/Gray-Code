import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import ToolMessage from '../../components/message/ToolMessage.vue'

/**
 * 回归测试：#「点击执行/拒绝时，输入栏文字被自动发出」修复
 *
 * 修复前：submitToolDecision 无条件把输入栏文本当作批注，插入为可见 user 消息、
 * 清空输入栏并随 toolConfirmation 发送到后端。
 * 修复后：点击工具卡片的确认/拒绝按钮只提交工具决策，绝不消费输入栏内容。
 * （批注功能已整体移除——用户在待确认工具时发送消息改为「中断当前回合」语义，
 * 由 App.vue handleSend 先 cancelStreamAndRejectTools 再正常发送。）
 *
 * 同时覆盖 PR #27 的一次性渠道覆盖语义：toolConfirmation 优先使用回合级
 * pendingConfigIdOverride，其次回落到全局渠道。
 */

const runtime = vi.hoisted(() => ({
  chatStore: undefined as any,
  backgroundTaskStore: undefined as any,
  sendToExtension: vi.fn(),
  onExtensionCommand: vi.fn(() => vi.fn()),
  showNotification: vi.fn(),
  getToolConfig: vi.fn()
}))

vi.mock('../../stores', () => ({
  useChatStore: () => runtime.chatStore
}))

vi.mock('../../stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: () => runtime.backgroundTaskStore
}))

vi.mock('../../utils/toolRegistry', () => ({
  getToolConfig: runtime.getToolConfig
}))

vi.mock('../../utils/tools', () => ({
  ensureMcpToolRegistered: vi.fn()
}))

vi.mock('../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  onExtensionCommand: runtime.onExtensionCommand,
  showNotification: runtime.showNotification
}))

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => {
    if (params && typeof params === 'object') return `${key}`
    return key
  } })
}))

function createChatStore() {
  const inputValue = ref('')
  const allMessages = ref<Array<Record<string, unknown>>>([])
  return {
    inputValue,
    allMessages,
    clearInputValue: vi.fn(() => { inputValue.value = '' }),
    getToolResponseById: vi.fn(() => undefined),
    currentConversationId: 'conv-1',
    currentConfig: { id: 'cfg-1' },
    pendingConfigIdOverride: null,
    pendingModelOverride: null,
    activeStreamId: null,
    isWaitingForResponse: false,
    currentPromptModeId: 'code'
  }
}

function makeTool(): Record<string, unknown> {
  return {
    id: 'tool-1',
    name: 'execute_command',
    status: 'awaiting_approval',
    args: { command: 'echo hi' },
    partialArgs: '',
    awaitingConfirmation: false
  }
}

describe('ToolMessage 工具确认/拒绝不消费输入栏文字', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    vi.clearAllMocks()
    runtime.chatStore = createChatStore()
    runtime.backgroundTaskStore = { tasks: {} }
    runtime.getToolConfig.mockReturnValue({ label: 'execute_command', expandable: false })
    runtime.sendToExtension.mockResolvedValue(undefined)

    wrapper = mount(ToolMessage, {
      props: { tools: [makeTool()] as any }
    })
  })

  afterEach(() => {
    wrapper.unmount()
  })

  async function clickConfirm() {
    await wrapper.find('button.confirm-btn').trigger('click')
    await flushPromises()
  }

  async function clickReject() {
    await wrapper.find('button.reject-btn').trigger('click')
    await flushPromises()
  }

  test('输入栏有文字时点击“确认”，不把文字发出、不清空输入栏', async () => {
    runtime.chatStore.inputValue.value = '这是我正在起草的下一条消息'

    await clickConfirm()

    const payloads = runtime.sendToExtension.mock.calls
      .filter(([channel]) => channel === 'toolConfirmation')
      .map(([, payload]) => payload)

    expect(payloads).toHaveLength(1)
    expect(payloads[0].toolResponses).toEqual([
      { id: 'tool-1', name: 'execute_command', confirmed: true }
    ])
    expect(payloads[0]).not.toHaveProperty('annotation')

    // 输入栏内容原样保留，未被清空
    expect(runtime.chatStore.clearInputValue).not.toHaveBeenCalled()
    expect(runtime.chatStore.inputValue.value).toBe('这是我正在起草的下一条消息')

    // 聊天流中未插入任何 user 消息
    expect(runtime.chatStore.allMessages.value).toHaveLength(0)
  })

  test('输入栏有文字时点击“拒绝”，同样不发送、不清空', async () => {
    runtime.chatStore.inputValue.value = '待办草稿'

    await clickReject()

    const payloads = runtime.sendToExtension.mock.calls
      .filter(([channel]) => channel === 'toolConfirmation')
      .map(([, payload]) => payload)

    expect(payloads).toHaveLength(1)
    expect(payloads[0].toolResponses).toEqual([
      { id: 'tool-1', name: 'execute_command', confirmed: false }
    ])
    expect(payloads[0]).not.toHaveProperty('annotation')
    expect(runtime.chatStore.clearInputValue).not.toHaveBeenCalled()
    expect(runtime.chatStore.inputValue.value).toBe('待办草稿')
    expect(runtime.chatStore.allMessages.value).toHaveLength(0)
  })

  test('确认提交携带正确渠道、流绑定与提示词模式', async () => {
    await clickConfirm()

    const payloads = runtime.sendToExtension.mock.calls
      .filter(([channel]) => channel === 'toolConfirmation')
      .map(([, payload]) => payload)

    expect(payloads[0]).toMatchObject({
      conversationId: 'conv-1',
      configId: 'cfg-1',
      promptModeId: 'code'
    })
    expect(typeof payloads[0].streamId).toBe('string')
    expect(payloads[0].streamId.length).toBeGreaterThan(0)
    expect(runtime.chatStore.activeStreamId).toBe(payloads[0].streamId)
    expect(runtime.chatStore.isWaitingForResponse).toBe(true)
  })

  test('PR #27 语义：回合级一次性渠道覆盖优先于全局渠道', async () => {
    runtime.chatStore.pendingConfigIdOverride = 'oneoff_b'
    runtime.chatStore.pendingModelOverride = 'model-b'

    await clickConfirm()

    const payloads = runtime.sendToExtension.mock.calls
      .filter(([channel]) => channel === 'toolConfirmation')
      .map(([, payload]) => payload)

    expect(payloads).toHaveLength(1)
    expect(payloads[0].configId).toBe('oneoff_b')
    expect(payloads[0].modelOverride).toBe('model-b')
    // 不改写全局渠道
    expect(runtime.chatStore.currentConfig.id).toBe('cfg-1')
  })

  test('无全局渠道但存在回合覆盖时仍可确认（不再卡死）', async () => {
    runtime.chatStore.currentConfig = null
    runtime.chatStore.pendingConfigIdOverride = 'oneoff_b'

    await clickConfirm()

    const payloads = runtime.sendToExtension.mock.calls
      .filter(([channel]) => channel === 'toolConfirmation')
      .map(([, payload]) => payload)

    expect(payloads).toHaveLength(1)
    expect(payloads[0].configId).toBe('oneoff_b')
  })
})
