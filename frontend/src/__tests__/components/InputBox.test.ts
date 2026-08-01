import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InputBox from '../../components/input/InputBox.vue'

function createClipboardItem(kind: 'string' | 'file', file: File | null = null): DataTransferItem {
  return {
    kind,
    type: kind === 'file' ? file?.type || 'application/octet-stream' : 'text/plain',
    getAsFile: () => file,
    getAsString: () => undefined,
    webkitGetAsEntry: () => null
  } as unknown as DataTransferItem
}

function createPasteEvent(items: DataTransferItem[]): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { items },
    configurable: true
  })
  return event
}

describe('InputBox paste', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    vi.useFakeTimers()
    wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('文字粘贴交给 Chromium 原生 insertFromPaste，并在事件后恢复编辑模式', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')])

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(editor.getAttribute('contenteditable')).toBe('plaintext-only')
    expect(wrapper.emitted('paste')).toBeUndefined()

    vi.runAllTimers()

    expect(editor.getAttribute('contenteditable')).toBe('true')
  })

  it('文件粘贴仍阻止默认插入并向父组件发送附件', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const file = new File(['content'], 'note.txt', { type: 'text/plain' })
    const event = createPasteEvent([
      createClipboardItem('string'),
      createClipboardItem('file', file)
    ])

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(wrapper.emitted('paste')).toEqual([[[file]]])
  })
})
