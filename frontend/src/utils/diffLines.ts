/**
 * 行级 diff 计算工具（GitHub 风格统一视图）
 *
 * 从 write_file.vue / apply_diff.vue 中抽取的公共算法，供变更查看面板与工具卡片复用：
 * - computeDiffLines：最长公共子序列（LCS）行匹配，产出 增/删/未变 三类行（带行号）；
 * - buildHunks：把 diff 行按「变更块 + 前后上下文」分组为 hunk（`@@ -a,b +c,d @@` 头）；
 * - diffStats：统计新增/删除行数。
 *
 * 大文件保护：LCS 的 O(n*m) DP 表超过 MAX_DIFF_DP_CELLS 时回退为「全部删除 + 全部新增」，
 * 与旧版 modal（electron-app/renderer/overlay.js）行为一致，避免大文件卡死渲染进程。
 */

export type DiffLineType = 'unchanged' | 'added' | 'deleted'

export interface DiffLine {
  type: DiffLineType
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface DiffHunk {
  /** hunk 起始行（1-based，无匹配内容时取紧邻的下一行） */
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffStats {
  added: number
  deleted: number
}

/** LCS DP 表上限：n*m 超过后放弃逐行匹配 */
export const MAX_DIFF_DP_CELLS = 2_000_000

interface LCSMatch {
  oldIndex: number
  newIndex: number
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length
  const n = newLines.length

  if (m * n > MAX_DIFF_DP_CELLS) {
    return []
  }

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度（一维滚动）
  const dp = new Int32Array((m + 1) * (n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1])
    }
  }

  const matches: LCSMatch[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      matches.push({ oldIndex: i, newIndex: j })
      i++
      j++
    } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) {
      i++
    } else {
      j++
    }
  }
  return matches
}

/**
 * 计算两个文件内容之间的行级差异。
 * 行号从 1 开始；删除行只有 oldLineNum，新增行只有 newLineNum。
 */
export function computeDiffLines(originalContent: string, newContent: string): DiffLine[] {
  const oldLines = originalContent.split('\n')
  const newLines = newContent.split('\n')
  const result: DiffLine[] = []

  const matches = computeLCS(oldLines, newLines)
  let oldIdx = 0
  let newIdx = 0
  let oldLineNum = 1
  let newLineNum = 1

  for (const match of matches) {
    while (oldIdx < match.oldIndex) {
      result.push({ type: 'deleted', content: oldLines[oldIdx], oldLineNum: oldLineNum++ })
      oldIdx++
    }
    while (newIdx < match.newIndex) {
      result.push({ type: 'added', content: newLines[newIdx], newLineNum: newLineNum++ })
      newIdx++
    }
    result.push({
      type: 'unchanged',
      content: oldLines[oldIdx],
      oldLineNum: oldLineNum++,
      newLineNum: newLineNum++
    })
    oldIdx++
    newIdx++
  }

  while (oldIdx < oldLines.length) {
    result.push({ type: 'deleted', content: oldLines[oldIdx], oldLineNum: oldLineNum++ })
    oldIdx++
  }
  while (newIdx < newLines.length) {
    result.push({ type: 'added', content: newLines[newIdx], newLineNum: newLineNum++ })
    newIdx++
  }

  return result
}

/**
 * 把 diff 行分组为 hunk（GitHub 风格：变更块与上下各 context 行上下文合并为一个 hunk）。
 */
export function buildHunks(diffLines: DiffLine[], context: number = 3): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let i = 0
  const n = diffLines.length

  while (i < n) {
    if (diffLines[i].type === 'unchanged') {
      i++
      continue
    }

    // 变更块起点：往前包含至多 context 行上下文
    const start = Math.max(0, i - context)
    let j = i
    while (j < n) {
      if (diffLines[j].type === 'unchanged') {
        // 连续上下文超过 context 行则结束当前 hunk
        let k = j
        while (k < n && diffLines[k].type === 'unchanged') k++
        if (k - j > context) break
        j = k
      } else {
        j++
      }
    }
    const end = Math.min(n, j + context)

    const lines = diffLines.slice(start, end)
    if (lines.length === 0) {
      i = j
      continue
    }

    const first = lines[0]
    const last = lines[lines.length - 1]
    const oldStart = first.oldLineNum ?? (last.oldLineNum ?? 1)
    const newStart = first.newLineNum ?? (last.newLineNum ?? 1)

    let oldCount = 0
    let newCount = 0
    for (const line of lines) {
      if (line.type !== 'added') oldCount++
      if (line.type !== 'deleted') newCount++
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines })
    i = j
  }

  return hunks
}

/** 统计新增/删除行数 */
export function diffStats(diffLines: DiffLine[]): DiffStats {
  let added = 0
  let deleted = 0
  for (const line of diffLines) {
    if (line.type === 'added') added++
    else if (line.type === 'deleted') deleted++
  }
  return { added, deleted }
}
