import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  insertTextAtCaret,
  insertLineBreakAtCaret
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

describe('insertTextAtCaret', () => {
  test('优先走 execCommand insertText，并标记 input 已由浏览器触发', () => {
    const editor = document.createElement('div')
    mockSelectionInEditor(editor)

    const result = insertTextAtCaret(editor, 'hello')

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'hello')
    expect(result).toEqual({ ok: true, inputFired: true })
  })

  test('execCommand 失败时回退手动插入，input 未触发，DOM 正确更新', () => {
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
  test('优先走 execCommand insertHTML（BR + ZWSP 一次写入 undo 栈）', () => {
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

  test('execCommand 失败时回退手动插入 BR + ZWSP', () => {
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
