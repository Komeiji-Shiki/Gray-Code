export interface DiffBlock {
  search: string
  replace: string
  /** 原文件起始行（1-based） */
  start_line?: number
  /** 新文件起始行（1-based）。仅 unified diff hunks 需要（old/new 起始行可能不同） */
  new_start_line?: number
  success?: boolean
  error?: string
  /** 是否被用户拒绝（部分接受/部分拒绝时由 rejectedBlockIndices 标记） */
  rejected?: boolean
}

export function parseUnifiedPatchToDiffBlocks(patch: string): DiffBlock[] {
  const normalized = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const blocks: DiffBlock[] = []

  let oldStart: number | undefined
  let newStart: number | undefined
  let searchLines: string[] | null = null
  let replaceLines: string[] | null = null

  const flush = () => {
    if (!searchLines || !replaceLines) return
    const block: DiffBlock = {
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n')
    }
    if (oldStart !== undefined) block.start_line = oldStart
    if (newStart !== undefined) block.new_start_line = newStart
    blocks.push(block)
    searchLines = null
    replaceLines = null
  }

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush()
      const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
      if (m) {
        oldStart = parseInt(m[1], 10) || 1
        newStart = parseInt(m[3], 10) || oldStart
      } else {
        // 裸 @@：行号未知，展示时不显示行号；后端若应用成功会返回真实 startLine 覆盖显示
        oldStart = undefined
        newStart = undefined
      }
      searchLines = []
      replaceLines = []
      continue
    }

    if (!searchLines || !replaceLines) {
      continue
    }

    if (!line) {
      continue
    }

    if (line.startsWith('\\')) {
      // "\\ No newline at end of file"
      continue
    }

    const prefix = line[0]
    const content = line.slice(1)

    if (prefix === ' ') {
      searchLines.push(content)
      replaceLines.push(content)
    } else if (prefix === '-') {
      searchLines.push(content)
    } else if (prefix === '+') {
      replaceLines.push(content)
    } else {
      // 兜底：AI 可能漏掉前缀，将其当作 context 行
      searchLines.push(line)
      replaceLines.push(line)
    }
  }

  flush()
  return blocks
}
