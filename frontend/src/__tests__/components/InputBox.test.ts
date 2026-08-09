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

function createPasteEvent(items: DataTransferItem[], plainText: string = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items,
      getData: (format: string) => (format === 'text/plain' ? plainText : '')
    },
    configurable: true
  })
  return event
}

function lastEmittedNodes(wrapper: VueWrapper): Array<{ type: string; text?: string }> {
  const emissions = wrapper.emitted('update:nodes')
  expect(emissions).toBeTruthy()
  return emissions![emissions!.length - 1][0] as Array<{ type: string; text?: string }>
}

describe('InputBox paste', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  it('单行文字粘贴：阻止默认插入并写入文本节点，不切换 contenteditable', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    // 回归核心：contenteditable 属性从头到尾不得被修改——属性值切换会重建
    // editing host 的 undo 栈，粘贴产生的 undo 记录随恢复动作一并销毁（Ctrl+Z 失效）
    const setAttributeSpy = vi.spyOn(editor, 'setAttribute')
    const event = createPasteEvent([createClipboardItem('string')], 'hello world')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.textContent).toContain('hello world')
    expect(lastEmittedNodes(wrapper)).toEqual([{ type: 'text', text: 'hello world' }])
    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(
      setAttributeSpy.mock.calls.some(([name]) => name === 'contenteditable')
    ).toBe(false)
    expect(wrapper.emitted('paste')).toBeUndefined()
  })

  it('多行文字粘贴：换行以 data-lim-break 标记的 BR 插入，提取节点保留换行', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], 'line1\nline2')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    // 裸 <br>（Chromium insertText 对 \n 的产物）会被 extractNodesFromEditor 吞掉换行，
    // 必须带 data-lim-break 标记
    expect(editor.querySelectorAll('br[data-lim-break="1"]')).toHaveLength(1)
    expect(lastEmittedNodes(wrapper)).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('Windows 剪贴板 \\r\\n 归一化为 \\n', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], 'a\r\nb')

    editor.dispatchEvent(event)

    expect(lastEmittedNodes(wrapper)).toEqual([{ type: 'text', text: 'a\nb' }])
  })

  it('execCommand 可用时一次性 insertHTML 写入（单个原生 undo 条目，Ctrl+Z 整体撤销）', () => {
    const execCommandMock = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true
    })

    try {
      const editor = wrapper.get('.input-editor').element as HTMLDivElement
      const event = createPasteEvent(
        [createClipboardItem('string')],
        'a\nb <tag> & "quote"'
      )

      editor.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      // 一次调用 = 一个 undo 条目；多行用带标记 <br>，文本经 HTML 转义
      expect(execCommandMock).toHaveBeenCalledTimes(1)
      expect(execCommandMock).toHaveBeenCalledWith(
        'insertHTML',
        false,
        'a<br data-lim-break="1">\u200Bb &lt;tag&gt; &amp; &quot;quote&quot;'
      )
      // execCommand 路径会自动派发 input 事件同步状态，不得再重复提取
      expect(wrapper.emitted('update:nodes')).toBeUndefined()
      expect(editor.getAttribute('contenteditable')).toBe('true')
    } finally {
      delete (document as { execCommand?: unknown }).execCommand
    }
  })

  it('空文本粘贴不干预默认行为', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], '')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:nodes')).toBeUndefined()
    expect(wrapper.emitted('paste')).toBeUndefined()
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

describe('InputBox 尺寸调整', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
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
})

describe('InputBox 占位符', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('空输入框显示占位符，有内容时隐藏', async () => {
    const empty = mount(InputBox, {
      props: { nodes: [], placeholder: '输入消息...' }
    })
    const emptyEditor = empty.get('.input-editor')
    expect(emptyEditor.classes()).toContain('is-empty')
    expect(emptyEditor.attributes('data-placeholder')).toBe('输入消息...')
    empty.unmount()

    const withText = mount(InputBox, {
      props: { nodes: [{ type: 'text', text: 'hello' }], placeholder: '输入消息...' }
    })
    const editor = withText.get('.input-editor')
    expect(editor.classes()).not.toContain('is-empty')
    expect(editor.attributes('data-placeholder')).toBe('')
    withText.unmount()

    const withWhitespace = mount(InputBox, {
      props: { nodes: [{ type: 'text', text: '   ' }], placeholder: '输入消息...' }
    })
    const wsEditor = withWhitespace.get('.input-editor')
    expect(wsEditor.classes()).not.toContain('is-empty')
    withWhitespace.unmount()
  })

  it('未传 placeholder 时回退到 i18n 提示', () => {
    const wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
    const editor = wrapper.get('.input-editor')
    expect(editor.classes()).toContain('is-empty')
    expect(editor.attributes('data-placeholder')).toBeTruthy()
    wrapper.unmount()
  })
})
