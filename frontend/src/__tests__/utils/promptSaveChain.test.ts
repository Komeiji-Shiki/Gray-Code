/**
 * 复现测试：保存提示词误报失败
 *
 * 目标：模拟 PromptSettings.vue saveConfig 的真实数据流——
 *  1. modes 数组（reactive）里 find 出当前模式（Proxy）
 *  2. 展开构造 updatedMode（嵌套字段仍是 Proxy）
 *  3. sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode })
 *  4. webview 端保存成功并回响应
 *  5. 验证前端 promise 能正常 resolve（而非 DataCloneError / 序列化失败）
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode'

/** 与 PromptSettings.vue 组件内定义的 PromptMode 接口同形状 */
interface PromptMode {
  id: string
  name: string
  icon?: string
  template: string
  promptAssemblyMode?: string | { type: string; presetId: string; version?: number }
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy?: string
  promptEntries?: Array<{
    id: string
    name: string
    type: string
    enabled: boolean
    role: string
    content: string
    order: number
  }>
  toolPolicy?: string[]
}

interface CapturedMessage {
  type: string
  requestId: string
  data: any
}

let capturedMessages: CapturedMessage[] = []

function installVscodeMock() {
  const postMessage = vi.fn((msg: CapturedMessage) => {
    capturedMessages.push(msg)
  })
  ;(window as any).acquireVsCodeApi = () => ({ postMessage })
  return postMessage
}

/** 与 PromptSettings.vue saveConfig 相同的 updatedMode 构造方式 */
function buildUpdatedMode(modesRef: ReturnType<typeof ref<PromptMode[]>>, selectedModeId: string): PromptMode {
  const currentMode = modesRef.value?.find(m => m.id === selectedModeId)
  const baseMode: PromptMode = currentMode || {
    id: selectedModeId,
    name: '默认模式',
    icon: 'symbol-method',
    template: 'tpl',
    promptAssemblyMode: 'template',
    dynamicTemplateEnabled: true,
    dynamicTemplate: 'dtpl',
    dynamicContextStrategy: 'single'
  }
  return {
    ...baseMode,
    template: 'cleaned-template',
    promptAssemblyMode: baseMode.promptAssemblyMode,
    dynamicTemplateEnabled: true,
    dynamicTemplate: 'cleaned-dynamic',
    dynamicContextStrategy: 'single',
    toolPolicy: ['read_file', 'write_file'],
    promptEntries: [
      { id: 'e1', name: 'entry', type: 'prompt', enabled: true, role: 'system', content: 'hello', order: 0 }
    ]
  }
}

describe('savePromptMode 完整链路（Proxy 数据）', () => {
  beforeEach(() => {
    capturedMessages = []
    installVscodeMock()
    // 真实应用中某个 store 初始化时会订阅消息，从而挂载全局分发器；
    // 测试里显式订阅一次，模拟真实运行环境。
    onMessageFromExtension(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('reactive modes 构造的 updatedMode 发送后能收到成功响应', async () => {
    // 模拟 loadConfig 后 modes.value = Object.values(result.modes)
    const modes = ref<PromptMode[]>([])
    modes.value = [
      {
        id: 'default',
        name: '默认',
        icon: 'symbol-method',
        template: 'old-template',
        promptAssemblyMode: { type: 'preset', presetId: 'code', version: 1 },
        dynamicTemplateEnabled: true,
        dynamicTemplate: 'old-dynamic',
        dynamicContextStrategy: 'preserve',
        toolPolicy: ['read_file']
      }
    ]

    const updatedMode = buildUpdatedMode(modes, 'default')

    // 与 saveConfig 相同：sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode })
    const pending = sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode })

    // 验证消息确实发出去了（没有被 DataCloneError 或 JSON 序列化错误拦截）
    expect(capturedMessages.length).toBe(1)
    const sent = capturedMessages[0]
    expect(sent.type).toBe('savePromptMode')
    expect(sent.data.mode.id).toBe('default')
    expect(sent.data.mode.promptAssemblyMode).toEqual({ type: 'preset', presetId: 'code', version: 1 })

    // 模拟 webview 端：handler 保存成功后 sendResponse
    const response = {
      type: 'response',
      requestId: sent.requestId,
      success: true,
      data: { success: true }
    }
    window.dispatchEvent(new MessageEvent('message', { data: response }))

    const result = await pending
    expect(result).toEqual({ success: true })
  })

  test('响应丢失时（webview 未就绪）promise 不会立即 resolve，但超时后会 reject', async () => {
    const modes = ref<PromptMode[]>([])
    modes.value = [{ id: 'default', name: '默认', icon: 'x', template: 'tpl', promptAssemblyMode: 'template', dynamicTemplateEnabled: true, dynamicTemplate: 'dtpl' }]
    const updatedMode = buildUpdatedMode(modes, 'default')

    // 不模拟响应 → 验证最终会 reject（避免真实等待 180s，传短超时）
    const pending = sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode }, { timeoutMs: 50 })
    await expect(pending).rejects.toThrow(/timed out/)
  })
})
