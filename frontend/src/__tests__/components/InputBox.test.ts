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

function createPasteEvent(items: DataTransferItem[], text = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items,
      getData: (type: string) => type === 'text/plain' ? text : ''
    },
    configurable: true
  })
  return event
}

describe('InputBox paste', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    document.execCommand = vi.fn(() => true)
    wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  it('文字粘贴以单次 insertText 写入原生撤销栈，不切换编辑宿主', async () => {
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    const event = createPasteEvent([createClipboardItem('string')], 'line 1\nline 2')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'line 1\nline 2')
    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(wrapper.emitted('paste')).toBeUndefined()
  })

  it('拖动手柄可放大输入框，双击后恢复自动高度', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    Object.defineProperty(editor, 'getBoundingClientRect', {
      value: () => ({ height: 80, top: 0, bottom: 80, left: 0, right: 320, width: 320, x: 0, y: 0, toJSON: () => ({}) }),
      configurable: true
    })

    await wrapper.get('.input-resize-handle').trigger('mousedown', { clientY: 200 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 100 }))
    expect(parseFloat(editor.style.height)).toBeGreaterThan(80)

    await wrapper.get('.input-resize-handle').trigger('dblclick')
    expect(parseFloat(editor.style.height)).toBeLessThanOrEqual(160)
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
