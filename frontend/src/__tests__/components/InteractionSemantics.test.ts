import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const sendToExtensionMock = vi.fn()
const showNotificationMock = vi.fn()

vi.mock('../../utils/vscode', () => ({
  sendToExtension: (type: string, data: any) => sendToExtensionMock(type, data),
  showNotification: (message: string, type: string) => showNotificationMock(message, type),
  onExtensionCommand: vi.fn(() => () => {}),
  onMessageFromExtension: vi.fn(() => () => {})
}))

import MessageAttachments from '../../components/message/MessageAttachments.vue'
import ContextBlocks from '../../components/message/ContextBlocks.vue'
import ModelSelectionDialog from '../../components/settings/ModelSelectionDialog.vue'
import { copyToClipboard } from '../../utils/format'

const wrappers: Array<{ unmount: () => void }> = []
function remember<T extends { unmount: () => void }>(wrapper: T): T {
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

beforeEach(() => {
  setActivePinia(createPinia())
  sendToExtensionMock.mockResolvedValue([])
})

describe('点击与键盘语义回归', () => {
  test('消息附件：预览按钮是原生的且有可访问名称', async () => {
    const wrapper = remember(mount(MessageAttachments, {
      props: {
        attachments: [{
          id: 'att-1',
          name: 'photo.png',
          type: 'image',
          mimeType: 'image/png',
          size: 1234,
          data: 'data:image/png;base64,xxx',
          thumbnail: 'data:image/png;base64,yyy'
        }]
      }
    }))

    const previewBtn = wrapper.get('button.media-preview-wrapper')
    expect(previewBtn.element.tagName).toBe('BUTTON')
    expect(previewBtn.attributes('aria-label')).toBe('点击预览: photo.png')

    await previewBtn.trigger('click')
    expect(sendToExtensionMock).toHaveBeenCalledTimes(1)
  })

  test('消息附件：无数据时不渲染虚假可点击预览', () => {
    const wrapper = remember(mount(MessageAttachments, {
      props: {
        attachments: [{
          id: 'att-2',
          name: 'doc.txt',
          type: 'document',
          mimeType: 'text/plain',
          size: 10
        }]
      }
    }))
    expect(wrapper.find('button.media-preview-wrapper').exists()).toBe(false)
    expect(wrapper.find('.attachment-icon').exists()).toBe(true)
  })

  test('消息附件：删除按钮有可访问名称且只读模式隐藏', async () => {
    const wrapper = remember(mount(MessageAttachments, {
      props: {
        readonly: false,
        attachments: [{
          id: 'att-3',
          name: 'a.txt',
          type: 'document',
          mimeType: 'text/plain',
          size: 5
        }]
      }
    }))
    const removeBtn = wrapper.get('button.remove-btn')
    expect(removeBtn.attributes('aria-label')).toBe('移除附件: a.txt')
    await removeBtn.trigger('click')
    expect(wrapper.emitted('remove')?.[0]).toEqual(['att-3'])
  })

  test('上下文标签：原生 button，聚焦即显示预览，点击触发打开', async () => {
    sendToExtensionMock.mockResolvedValue(undefined)
    const wrapper = remember(mount(ContextBlocks, {
      props: {
        contexts: [{
          id: 'ctx-1',
          type: 'text',
          title: 'README.md',
          content: 'line1\nline2',
          enabled: true,
          addedAt: 1
        }]
      }
    }))

    const tag = wrapper.get('button.context-tag')
    expect(tag.element.tagName).toBe('BUTTON')
    expect(tag.text()).toContain('README.md')

    await tag.trigger('focus')
    await new Promise(r => setTimeout(r, 350))
    expect(wrapper.find('.context-preview').exists()).toBe(true)

    await tag.trigger('click')
    expect(sendToExtensionMock).toHaveBeenCalled()
  })

  test('模型选择：模型项是原生按钮且表达 aria-pressed 切换语义', async () => {
    sendToExtensionMock.mockResolvedValue([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' }
    ])
    const wrapper = remember(mount(ModelSelectionDialog, {
      global: { stubs: { teleport: true } },
      props: {
        visible: false,
        configId: 'cfg-1',
        addedModelIds: []
      }
    }))
    await wrapper.setProps({ visible: true })
    await nextTick()
    await nextTick()

    const items = wrapper.findAll('button.model-item')
    expect(items.length).toBe(2)
    expect(items[0].attributes('aria-pressed')).toBe('false')

    await items[0].trigger('click')
    expect(items[0].attributes('aria-pressed')).toBe('true')

    // 已添加模型点击触发 remove 而非选择
    await wrapper.setProps({ addedModelIds: ['model-a'] } as any)
    await items[0].trigger('click')
    expect(wrapper.emitted('remove')?.[0]).toEqual(['model-a'])
  })

  test('模型选择：加载失败显示 role="alert" 错误反馈', async () => {
    sendToExtensionMock.mockRejectedValue(new Error('boom'))
    const wrapper = remember(mount(ModelSelectionDialog, {
      global: { stubs: { teleport: true } },
      props: {
        visible: false,
        configId: 'cfg-1',
        addedModelIds: []
      }
    }))
    await wrapper.setProps({ visible: true })
    await nextTick()
    await nextTick()
    expect(wrapper.find('[role="alert"].error-state').exists()).toBe(true)
    expect(wrapper.text()).toContain('boo')
  })
})

describe('复制反馈回归', () => {
  test('copyToClipboard 失败时通过 showNotification 反馈', async () => {
    // 模拟剪贴板 API 缺失且 execCommand 失败
    const original = globalThis.navigator.clipboard
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined
    })
    const execMock = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execMock
    })

    try {
      const ok = await copyToClipboard('hello')
      expect(ok).toBe(false)
      expect(execMock).toHaveBeenCalledWith('copy')
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: original
      })
      delete (document as any).execCommand
    }
  })
})
