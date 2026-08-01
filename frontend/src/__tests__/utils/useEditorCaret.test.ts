import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildPlainTextHtml,
  insertTextAtCaret,
  insertLineBreakAtCaret,
  insertPlainTextWithLineBreaksAtCaret
} from '../../components/input/inputBox/useEditorCaret'

let execCommandMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  execCommandMock = vi.fn(() => true)
  document.execCommand = execCommandMock as unknown as typeof document.execCommand
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * jsdom 的 Selection 是残缺 stub（addRange 为 no-op、getRangeAt 会抛错），
 * 这里 mock 一个持有真实 Range 的 Selection，让 getRangeInEditor 能正常工作。
 */
function mockSelectionInEditor(editor: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
    addRange: vi.fn()
  } as unknown as Selection
  vi.spyOn(window, 'getSelection').mockReturnValue(selection)
  return range
}

describe('buildPlainTextHtml', () => {
  it('纯文本原样保留', () => {
    expect(buildPlainTextHtml('hello world')).toBe('hello world')
  })

  it('换行转为 lim-break BR + ZWSP', () => {
    expect(buildPlainTextHtml('a\nb')).toBe('a<br data-lim-break="1">\u200Bb')
  })

  it('Windows 换行被规范化', () => {
    expect(buildPlainTextHtml('a\r\nb')).toBe('a<br data-lim-break="1">\u200Bb')
  })

  it('连续换行生成多个 BR', () => {
    expect(buildPlainTextHtml('a\n\nb')).toBe(
      'a<br data-lim-break="1">\u200B<br data-lim-break="1">\u200Bb'
    )
  })

  it('HTML 特殊字符被转义', () => {
    expect(buildPlainTextHtml('<script>&')).toBe('&lt;script&gt;&amp;')
  })

  it('空文本返回空串', () => {
    expect(buildPlainTextHtml('')).toBe('')
  })
})

describe('insertTextAtCaret', () => {
  it('优先走 execCommand insertText，并标记 input 已由浏览器触发', () => {
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertTextAtCaret(editor, 'hello')

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'hello')
    expect(result).toEqual({ ok: true, inputFired: true })
  })

  it('execCommand 失败时回退手动插入，input 未触发，DOM 正确更新', () => {
    execCommandMock.mockReturnValue(false)
    const editor = document.createElement('div')
    editor.appendChild(document.createTextNode('ab'))
    const range = mockSelectionInEditor(editor)
    range.setStart(editor.firstChild!, 1)
    range.collapse(true)

    const result = insertTextAtCaret(editor, 'X')

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'X')
    expect(result).toEqual({ ok: true, inputFired: false })
    expect(editor.textContent).toBe('aXb')
  })
})

describe('insertLineBreakAtCaret', () => {
  it('优先走 execCommand insertHTML（BR + ZWSP 一次写入 undo 栈）', () => {
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertLineBreakAtCaret(editor)

    expect(execCommandMock).toHaveBeenCalledWith(
      'insertHTML',
      false,
      '<br data-lim-break="1">\u200B'
    )
    expect(result).toEqual({ ok: true, inputFired: true })
  })

  it('execCommand 失败时回退手动插入 BR + ZWSP', () => {
    execCommandMock.mockReturnValue(false)
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertLineBreakAtCaret(editor)

    expect(result).toEqual({ ok: true, inputFired: false })
    const br = editor.querySelector('br')
    expect(br).not.toBeNull()
    expect(br!.dataset.limBreak).toBe('1')
    expect(editor.lastChild?.textContent).toBe('\u200B')
  })
})

describe('insertPlainTextWithLineBreaksAtCaret', () => {
  it('单行文本：一次 insertHTML 整体进入 undo 栈', () => {
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertPlainTextWithLineBreaksAtCaret(editor, 'hello')

    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith('insertHTML', false, 'hello')
    expect(result).toEqual({ ok: true, inputFired: true })
  })

  it('多行文本：单次 insertHTML 且换行结构完整', () => {
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertPlainTextWithLineBreaksAtCaret(editor, 'a\nb')

    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(
      'insertHTML',
      false,
      'a<br data-lim-break="1">\u200Bb'
    )
    expect(result).toEqual({ ok: true, inputFired: true })
  })

  it('execCommand 失败时回退逐段手动插入，文本与换行结构保持', () => {
    execCommandMock.mockReturnValue(false)
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertPlainTextWithLineBreaksAtCaret(editor, 'a\nb')

    expect(result).toEqual({ ok: true, inputFired: false })
    expect(editor.textContent).toBe('a\u200Bb')
    expect(editor.querySelectorAll('br[data-lim-break="1"]').length).toBe(1)
  })

  it('空文本时手动路径不产生任何节点', () => {
    execCommandMock.mockReturnValue(false)
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertPlainTextWithLineBreaksAtCaret(editor, '')

    expect(result).toEqual({ ok: true, inputFired: false })
    expect(editor.childNodes.length).toBe(0)
  })
})
