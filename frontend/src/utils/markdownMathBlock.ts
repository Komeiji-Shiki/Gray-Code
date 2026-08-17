/**
 * Markdown-it 的块级数学规则。
 *
 * 支持 $$...$$ 与 \[...\] 两种常见的显示公式定界符。规则独立于 KaTeX
 * renderer，供完整 MarkdownRenderer 与流式边界解析器共享，确保 table 的
 * blockquote terminator 链在两处完全一致。
 */
interface MathBlockDelimiter {
  opener: string
  closer: string
}

const MATH_BLOCK_DELIMITERS: MathBlockDelimiter[] = [
  { opener: '$$', closer: '$$' },
  { opener: '\\[', closer: '\\]' }
]

export function markdownItMathBlock(
  state: any,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  let max = state.eMarks[startLine]
  const sourceStart = state.src.slice(pos, max)
  const delimiter = MATH_BLOCK_DELIMITERS.find(({ opener }) => sourceStart.startsWith(opener))

  if (!delimiter) return false

  // 作为 paragraph/list/blockquote terminator 探测时，只需确认 opener。
  if (silent) return true

  const { opener, closer } = delimiter
  const firstLine = sourceStart.slice(opener.length)
  if (firstLine.trim().endsWith(closer)) {
    const token = state.push('math_block', 'div', 0)
    token.block = true
    token.markup = opener
    token.map = [startLine, startLine + 1]
    token.content = firstLine.trim().slice(0, -closer.length)
    state.line = startLine + 1
    return true
  }

  let nextLine = startLine + 1
  let content = firstLine
  while (nextLine < endLine) {
    pos = state.bMarks[nextLine] + state.tShift[nextLine]
    max = state.eMarks[nextLine]

    const line = state.src.slice(pos, max)
    const endPos = line.indexOf(closer)
    if (endPos !== -1) {
      content += `\n${line.slice(0, endPos)}`

      const token = state.push('math_block', 'div', 0)
      token.block = true
      token.markup = opener
      token.map = [startLine, nextLine + 1]
      token.content = content
      state.line = nextLine + 1
      return true
    }

    content += `\n${line}`
    nextLine++
  }

  return false
}
