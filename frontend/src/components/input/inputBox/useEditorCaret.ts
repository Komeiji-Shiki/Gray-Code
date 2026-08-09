import { escapeHtml } from '../../common/markdownUtils'

export interface DomPoint {
  container: Node
  offset: number
}

export interface InsertResult {
  /** 插入是否成功 */
  ok: boolean
  /**
   * 浏览器是否已自动派发 input 事件（execCommand 路径为 true）。
   * 为 true 时调用方不应再手动触发 handleInput，避免重复提取节点。
   */
  inputFired: boolean
}

export function getRangeInEditor(editor: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection) return null

  editor.focus()

  if (selection.rangeCount === 0) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    return range
  }

  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) {
    const newRange = document.createRange()
    newRange.selectNodeContents(editor)
    newRange.collapse(false)
    selection.removeAllRanges()
    selection.addRange(newRange)
    return newRange
  }

  return range
}

export function getCaretTextOffset(editor: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0

  const range = selection.getRangeAt(0)
  const preRange = range.cloneRange()
  preRange.selectNodeContents(editor)
  preRange.setEnd(range.startContainer, range.startOffset)

  let offset = 0
  const fragment = preRange.cloneContents()

  function countText(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent || ''
      offset += raw.replace(/\u200B/g, '').length
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement

    if (el.tagName === 'BR') {
      if (el.dataset.limBreak === '1') offset += 1
      return
    }

    if (el.classList.contains('context-chip')) return

    for (const child of Array.from(node.childNodes)) countText(child)
  }

  for (const child of Array.from(fragment.childNodes)) countText(child)

  return offset
}

function insertTextAtCaretManual(editor: HTMLElement, text: string): boolean {
  const range = getRangeInEditor(editor)
  const selection = window.getSelection()
  if (!range || !selection) return false

  range.deleteContents()

  const textNode = document.createTextNode(text)
  range.insertNode(textNode)

  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)

  return true
}

/**
 * 在光标处插入纯文本。
 * 优先走 document.execCommand('insertText')：既是纯文本（不带富文本样式），
 * 又会写入浏览器原生 undo 栈，Ctrl+Z 可以整体撤销。
 * 浏览器不支持时回退到手动 DOM 插入（功能可用，但不会进入 undo 栈）。
 */
export function insertTextAtCaret(editor: HTMLElement, text: string): InsertResult {
  getRangeInEditor(editor)

  if (document.execCommand('insertText', false, text)) {
    return { ok: true, inputFired: true }
  }

  insertTextAtCaretManual(editor, text)
  return { ok: true, inputFired: false }
}

function insertLineBreakAtCaretManual(editor: HTMLElement): boolean {
  const range = getRangeInEditor(editor)
  const selection = window.getSelection()
  if (!range || !selection) return false

  range.deleteContents()

  const br = document.createElement('br')
  br.dataset.limBreak = '1'
  range.insertNode(br)

  const zwsp = document.createTextNode('\u200B')
  range.setStartAfter(br)
  range.collapse(true)
  range.insertNode(zwsp)

  range.setStart(zwsp, 1)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)

  return true
}

/**
 * 在光标处插入换行。
 * 优先走 document.execCommand('insertHTML')：一次调用写入一个 undo 条目，
 * Ctrl+Z 可整体撤销该换行。BR 保留 data-lim-break 标记并带 ZWSP，
 * 与现有节点提取、删除逻辑完全兼容。
 * 浏览器不支持时回退到手动 DOM 插入。
 */
export function insertLineBreakAtCaret(editor: HTMLElement): InsertResult {
  getRangeInEditor(editor)

  if (document.execCommand('insertHTML', false, '<br data-lim-break="1">\u200B')) {
    return { ok: true, inputFired: true }
  }

  insertLineBreakAtCaretManual(editor)
  return { ok: true, inputFired: false }
}

function insertPlainTextManual(editor: HTMLElement, lines: string[]): void {
  const range = getRangeInEditor(editor)
  const selection = window.getSelection()
  if (!range || !selection) return

  range.deleteContents()

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      const textNode = document.createTextNode(lines[i])
      range.insertNode(textNode)
      range.setStartAfter(textNode)
    }
    if (i < lines.length - 1) {
      // 与 renderNodesToDOM / insertLineBreakAtCaretManual 一致：标记 BR + ZWSP
      const br = document.createElement('br')
      br.dataset.limBreak = '1'
      range.insertNode(br)
      const zwsp = document.createTextNode('\u200B')
      range.setStartAfter(br)
      range.insertNode(zwsp)
      range.setStartAfter(zwsp)
    }
  }

  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 粘贴路径专用：把多行纯文本作为「单个原生 undo 条目」插入，Ctrl+Z 一次整体撤销。
 *
 * 为什么不能靠临时切换 contenteditable=plaintext-only 走 Chromium 原生粘贴：
 * contenteditable 属性值变化（'true' ⇄ 'plaintext-only'）会重建 editing host 的
 * undo 栈——粘贴写入的 undo 记录随后被恢复 'true' 的动作一并销毁，Ctrl+Z 失效。
 *
 * 为什么不用 execCommand('insertText') 直接插多行文本：Chromium 会把 \n 转成
 * 无标记的裸 <br>，而 extractNodesFromEditor 只认 data-lim-break="1" 的 <br>，
 * 换行会被提取逻辑吞掉。这里改用一次性 insertHTML：转义后的纯文本 +
 * 带标记 <br data-lim-break="1">\u200B，与渲染/提取/删除逻辑的内部表示完全一致，
 * 且一次 execCommand 调用恰好产生一个 undo 条目（多次 insertText/insertHTML
 * 拆段调用会产生 2N-1 个独立条目，需要反复 Ctrl+Z）。
 *
 * execCommand 不可用（jsdom 等环境）时回退手动 DOM 插入：功能可用，不进 undo 栈。
 */
export function insertPlainTextAsSingleUndo(editor: HTMLElement, text: string): InsertResult {
  const lines = text.split('\n')

  getRangeInEditor(editor)

  if (typeof document.execCommand === 'function') {
    const html = lines.map(escapeHtml).join('<br data-lim-break="1">\u200B')
    try {
      if (document.execCommand('insertHTML', false, html)) {
        return { ok: true, inputFired: true }
      }
    } catch {
      // jsdom 等未实现 execCommand 的环境：落入手动路径
    }
  }

  insertPlainTextManual(editor, lines)
  return { ok: true, inputFired: false }
}

function getDomPointFromTextOffset(editor: HTMLElement, targetOffset: number): DomPoint {
  let textCount = 0
  const children = Array.from(editor.childNodes)

  for (let i = 0; i < children.length; i++) {
    const child = children[i]

    if (targetOffset === textCount) {
      return { container: editor, offset: i }
    }

    if (child.nodeType === Node.TEXT_NODE) {
      const t = child as Text
      const raw = t.data
      const logicalLen = raw.replace(/\u200B/g, '').length

      if (targetOffset <= textCount + logicalLen) {
        const need = targetOffset - textCount
        let seen = 0
        for (let j = 0; j <= raw.length; j++) {
          if (seen === need) {
            return { container: t, offset: j }
          }
          const ch = raw[j]
          if (ch && ch !== '\u200B') seen += 1
        }
        return { container: t, offset: raw.length }
      }

      textCount += logicalLen
      continue
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const el = child as HTMLElement

    if (el.tagName === 'BR' && el.dataset.limBreak === '1') {
      if (targetOffset === textCount + 1) {
        return { container: editor, offset: i + 1 }
      }
      textCount += 1
      continue
    }

    if (el.classList.contains('context-chip')) {
      continue
    }
  }

  return { container: editor, offset: editor.childNodes.length }
}

export function replaceTextRangeByOffsets(
  editor: HTMLElement,
  startOffset: number,
  endOffset: number,
  replacement: string = ''
) {
  const start = getDomPointFromTextOffset(editor, startOffset)
  const end = getDomPointFromTextOffset(editor, endOffset)

  const range = document.createRange()
  range.setStart(start.container, start.offset)
  range.setEnd(end.container, end.offset)
  range.deleteContents()

  if (replacement) {
    const textNode = document.createTextNode(replacement)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
  }

  range.collapse(true)
  const selection = window.getSelection()
  if (selection) {
    selection.removeAllRanges()
    selection.addRange(range)
  }
}
