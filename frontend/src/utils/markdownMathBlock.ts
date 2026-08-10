/**
 * Markdown-it 的 $$...$$ 块规则。
 *
 * 独立于 KaTeX renderer，供完整 MarkdownRenderer 与流式边界解析器共享，
 * 确保 table 的 blockquote terminator 链在两处完全一致。
 */
export function markdownItMathBlock(
  state: any,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  let max = state.eMarks[startLine]

  if (pos + 2 > max) return false
  if (state.src.slice(pos, pos + 2) !== '$$') return false

  // 作为 paragraph/list/blockquote terminator 探测时，只需确认 opener。
  if (silent) return true

  const firstLine = state.src.slice(pos + 2, max)
  if (firstLine.trim().endsWith('$$')) {
    const token = state.push('math_block', 'div', 0)
    token.block = true
    token.markup = '$$'
    token.map = [startLine, startLine + 1]
    token.content = firstLine.trim().slice(0, -2)
    state.line = startLine + 1
    return true
  }

  let nextLine = startLine + 1
  let content = firstLine
  while (nextLine < endLine) {
    pos = state.bMarks[nextLine] + state.tShift[nextLine]
    max = state.eMarks[nextLine]

    const line = state.src.slice(pos, max)
    const endPos = line.indexOf('$$')
    if (endPos !== -1) {
      content += `\n${line.slice(0, endPos)}`

      const token = state.push('math_block', 'div', 0)
      token.block = true
      token.markup = '$$'
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
