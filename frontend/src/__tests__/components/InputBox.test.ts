import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import InputBox from '../../components/input/InputBox.vue'
import type { EditorNode } from '../../types/editorNode'

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

  test('单行文字粘贴：阻止默认插入并写入文本节点，不切换 contenteditable', () => {
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

  test('多行文字粘贴：换行以 data-lim-break 标记的 BR 插入，提取节点保留换行', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], 'line1\nline2')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    // 裸 <br>（Chromium insertText 对 \n 的产物）会被 extractNodesFromEditor 吞掉换行，
    // 必须带 data-lim-break 标记
    expect(editor.querySelectorAll('br[data-lim-break="1"]')).toHaveLength(1)
    expect(lastEmittedNodes(wrapper)).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  test('Windows 剪贴板 \\r\\n 归一化为 \\n', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], 'a\r\nb')

    editor.dispatchEvent(event)

    expect(lastEmittedNodes(wrapper)).toEqual([{ type: 'text', text: 'a\nb' }])
  })

  test('execCommand 可用时一次性 insertHTML 写入（单个原生 undo 条目，Ctrl+Z 整体撤销）', () => {
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

  test('空文本粘贴不干预默认行为', () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], '')

    editor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:nodes')).toBeUndefined()
    expect(wrapper.emitted('paste')).toBeUndefined()
  })

  test('文件粘贴仍阻止默认插入并向父组件发送附件', () => {
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

  test('拖动手柄可放大输入框，双击后恢复自动高度', async () => {
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

  test('空输入框显示占位符，有内容时隐藏', async () => {
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

  test('未传 placeholder 时回退到 i18n 提示', () => {
    const wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
    const editor = wrapper.get('.input-editor')
    expect(editor.classes()).toContain('is-empty')
    expect(editor.attributes('data-placeholder')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('InputBox 外部状态同步（发送后清空回归）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 真实父组件包装：@update:nodes 回流写回 nodes，复现 Vue flush 时序
  // （emit 触发父组件更新 → flushJobs 里 InputBox watch 执行时 isInputting 仍为 true）
  function mountWithParent() {
    const wrapper = mount({
      components: { InputBox },
      setup() {
        const nodes = ref<EditorNode[]>([])
        return { nodes }
      },
      template: '<InputBox :nodes="nodes" @update:nodes="nodes = $event" />'
    })
    return wrapper
  }

  test('真实输入路径（isInputting 窗口内跳过同步）后发送清空：DOM 重建、残留文本与 placeholder 不叠加', async () => {
    const wrapper = mountWithParent()
    await nextTick()
    const editor = wrapper.get('.input-editor').element as HTMLDivElement

    // 模拟用户输入：DOM 由浏览器直接编辑并派发 input 事件（真实 handleInput 路径，
    // 含 isInputting 置位/复位、emit 回流触发父组件 props 更新）
    editor.textContent = 'hello'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    // flush：父组件 nodes 回写 → InputBox watch 在 isInputting 窗口内被短路跳过同步；
    // handleInput 的 nextTick 随后复位 isInputting
    await nextTick()
    await nextTick()
    expect(editor.textContent).toContain('hello')

    // 模拟发送清空：父组件把 nodes 置空（InputArea.handleSend 语义）
    ;(wrapper.vm as any).nodes = []
    await nextTick()
    await nextTick()

    // 回归断言：DOM 必须被重建清空——旧文本残留即「placeholder 与文本叠放」现象
    expect(editor.textContent ?? '').not.toContain('hello')
    expect(editor.classList.contains('is-empty')).toBe(true)
    wrapper.unmount()
  })

  test('外部替换节点内容时 DOM 同步刷新（renderNodesToDom 路径）', async () => {
    const wrapper = mountWithParent()
    await nextTick()
    const editor = wrapper.get('.input-editor').element as HTMLDivElement

    // 初始渲染有内容（renderNodesToDom 路径），指纹与 DOM 同步
    ;(wrapper.vm as any).nodes = [{ type: 'text', text: 'aaa' }]
    await nextTick()
    await nextTick()
    expect(editor.textContent).toContain('aaa')

    // 外部整体替换为新内容
    ;(wrapper.vm as any).nodes = [{ type: 'text', text: 'bbb' }]
    await nextTick()
    await nextTick()
    expect(editor.textContent).toContain('bbb')
    wrapper.unmount()
  })
})


describe('InputBox 双撤销栈跨栈边界（前端 M2）', () => {
  // 自定义撤销栈（接管 Ctrl+Z/Y）与浏览器原生 undo 栈（粘贴写 execCommand 记录）并存：
  // 粘贴→手动编辑→撤销 序列必须逐条回退，不能错位/跨栈跳变。
  // 用真实父组件包装：update:nodes 回流写回 nodes——restoreHistoryEntry 的 nextTick
  // 渲染依赖 props.nodes 同步，静态 props 会让 undo 后渲染为空。
  let wrapper: VueWrapper

  beforeEach(() => {
    wrapper = mount({
      components: { InputBox },
      setup() {
        const nodes = ref<EditorNode[]>([])
        return { nodes }
      },
      template: '<InputBox :nodes="nodes" @update:nodes="nodes = $event" />'
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  function typeText(text: string) {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    editor.textContent = text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function pressUndo() {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
  }

  function pressRedo() {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }))
  }

  function pasteText(text: string) {
    const execCommandMock = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true
    })
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const event = createPasteEvent([createClipboardItem('string')], text)
    editor.dispatchEvent(event)
    // jsdom 的 execCommand mock 不产生真实 DOM 变更/不派发 input 事件；
    // 真实 Chromium 中 execCommand('insertText') 更新 DOM 并派发 input 事件（handleInput 入自定义栈）——
    // 手动模拟该行为，才能验证「粘贴路径与手动输入共享自定义撤销栈」的跨栈边界
    editor.textContent = (editor.textContent ?? '') + text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return execCommandMock
  }

  test('粘贴 → 手动编辑 → Ctrl+Z 逐条回退（不跨栈跳变）', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement

    // 1. 手动输入 base（自定义栈快照 1）
    typeText('base')
    await nextTick()

    // 2. 粘贴 hello（写原生 undo 栈 + input 事件 → 自定义栈快照 2）
    const execCommandMock = pasteText('hello')
    await nextTick()
    expect(execCommandMock).toHaveBeenCalled()

    // 3. 手动追加 !（自定义栈快照 3）
    typeText('basehello!')
    await nextTick()

    // 4. Ctrl+Z → 应回到快照 2（basehello，粘贴后）而非跨过粘贴直接到 base
    pressUndo()
    await nextTick()
    await nextTick()
    expect(editor.textContent).toBe('basehello')

    // 5. Ctrl+Z → 回到快照 1（base，粘贴前）
    pressUndo()
    await nextTick()
    await nextTick()
    expect(editor.textContent).toBe('base')

    // 6. Ctrl+Y → 回到快照 2
    pressRedo()
    await nextTick()
    await nextTick()
    expect(editor.textContent).toBe('basehello')

    delete (document as { execCommand?: unknown }).execCommand
  })

  test('粘贴后直接 Ctrl+Z 一次整体撤销本次粘贴（原生 undo 条目）', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement

    typeText('base')
    await nextTick()
    pasteText('hello')
    await nextTick()

    // 自定义栈：粘贴也入栈 → Ctrl+Z 回到粘贴前
    pressUndo()
    await nextTick()
    await nextTick()
    expect(editor.textContent).toBe('base')

    delete (document as { execCommand?: unknown }).execCommand
  })
})

// ========== drag & drop ==========

describe('InputBox drag & drop', () => {
  let wrapper: VueWrapper

  interface MockDropDataTransfer {
    items?: DataTransferItem[]
    files?: File[]
    getData?: (format: string) => string
    dropEffect?: string
  }

  function createDropEvent(dataTransfer: MockDropDataTransfer, mods?: { ctrlKey?: boolean; shiftKey?: boolean }): DragEvent {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        items: [],
        files: [],
        dropEffect: 'copy',
        getData: () => '',
        ...dataTransfer
      } as unknown as DataTransfer,
      configurable: true
    })
    Object.defineProperty(event, 'ctrlKey', { value: !!mods?.ctrlKey, configurable: true })
    Object.defineProperty(event, 'shiftKey', { value: !!mods?.shiftKey, configurable: true })
    return event
  }

  function fileItem(file: File): DataTransferItem {
    return {
      kind: 'file',
      type: file.type || 'application/octet-stream',
      getAsFile: () => file,
      getAsString: () => undefined,
      webkitGetAsEntry: () => null
    } as unknown as DataTransferItem
  }

  beforeEach(() => {
    wrapper = mount(InputBox, {
      props: { nodes: [] }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  test('拖入 PNG 图片：emit drop-files 且不触发路径逻辑', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const png = new File(['x'], 'photo.png', { type: 'image/png' })

    editor.dispatchEvent(createDropEvent({ items: [fileItem(png)] }))

    expect(wrapper.emitted('drop-files')![0]).toEqual([[png]])
    expect(wrapper.emitted('drop-file-items')).toBeUndefined()
  })

  test('拖入 GIF/PDF/视频：均按附件处理', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const gif = new File(['x'], 'anim.gif', { type: 'image/gif' })
    const pdf = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    const mp4 = new File(['x'], 'clip.mp4', { type: 'video/mp4' })

    editor.dispatchEvent(createDropEvent({ items: [fileItem(gif), fileItem(pdf), fileItem(mp4)] }))

    expect(wrapper.emitted('drop-files')![0]).toEqual([[gif, pdf, mp4]])
  })

  test('拖入 txt（非目标类型）：走原有路径逻辑，不 emit drop-files', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' })

    editor.dispatchEvent(createDropEvent({ items: [fileItem(txt)], files: [txt] }))

    expect(wrapper.emitted('drop-files')).toBeUndefined()
    // extractVscodeDropItems 兜底 dt.files 时用文件名作为候选路径 → 仍走路径逻辑
    expect(wrapper.emitted('drop-file-items')).toBeTruthy()
  })

  test('Ctrl+Shift 拖入图片：保持路径文本语义，不 emit drop-files', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const png = new File(['x'], 'photo.png', { type: 'image/png' })

    editor.dispatchEvent(createDropEvent({ items: [fileItem(png)], files: [png] }, { ctrlKey: true, shiftKey: true }))

    expect(wrapper.emitted('drop-files')).toBeUndefined()
  })

  test('items 为空时由 dt.files 兜底收集', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const jpg = new File(['x'], 'shot.jpg', { type: 'image/jpeg' })

    editor.dispatchEvent(createDropEvent({ items: [], files: [jpg] }))

    expect(wrapper.emitted('drop-files')![0]).toEqual([[jpg]])
  })

  test('混合拖入：只收集目标类型文件', async () => {
    const editor = wrapper.get('.input-editor').element as HTMLDivElement
    const webp = new File(['x'], 'pic.webp', { type: 'image/webp' })
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' })
    const zip = new File(['x'], 'archive.zip', { type: 'application/zip' })

    editor.dispatchEvent(createDropEvent({ items: [fileItem(webp), fileItem(txt), fileItem(zip)] }))

    expect(wrapper.emitted('drop-files')![0]).toEqual([[webp]])
  })
})