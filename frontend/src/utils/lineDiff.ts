export type LineDiffType = 'unchanged' | 'deleted' | 'added'

export interface LineDiffEntry {
  type: LineDiffType
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface LineDiffResult {
  lines: LineDiffEntry[]
  added: number
  deleted: number
  oldLineCount: number
  newLineCount: number
  lineNumberWidth: number
  degraded: boolean
}

interface Match {
  oldIndex: number
  newIndex: number
}

const DEFAULT_EDIT_DISTANCE_LIMIT = 768

function trimCommonEdges(oldLines: string[], newLines: string[]): { prefix: number; suffix: number } {
  const minLength = Math.min(oldLines.length, newLines.length)
  let prefix = 0
  while (prefix < minLength && oldLines[prefix] === newLines[prefix]) prefix++

  let suffix = 0
  const maxSuffix = minLength - prefix
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }
  return { prefix, suffix }
}

function toLineIds(oldLines: string[], newLines: string[]): { oldIds: Int32Array; newIds: Int32Array } {
  const ids = new Map<string, number>()
  const getId = (line: string): number => {
    const existing = ids.get(line)
    if (existing !== undefined) return existing
    const id = ids.size + 1
    ids.set(line, id)
    return id
  }

  return {
    oldIds: Int32Array.from(oldLines, getId),
    newIds: Int32Array.from(newLines, getId)
  }
}

function findMyersMatches(
  oldLines: string[],
  newLines: string[],
  editDistanceLimit: number
): { matches: Match[]; degraded: boolean } {
  const n = oldLines.length
  const m = newLines.length
  if (n === 0 || m === 0) return { matches: [], degraded: false }

  const { oldIds, newIds } = toLineIds(oldLines, newLines)
  const limit = Math.min(n + m, editDistanceLimit)
  const offset = limit + 1
  let frontier = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  let foundDistance = -1

  for (let distance = 0; distance <= limit; distance++) {
    trace.push(frontier)
    const next = frontier.slice()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let x: number
      if (
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
      ) {
        x = frontier[index + 1]
      } else {
        x = frontier[index - 1] + 1
      }
      let y = x - diagonal
      while (x < n && y < m && oldIds[x] === newIds[y]) {
        x++
        y++
      }
      next[index] = x
      if (x >= n && y >= m) {
        foundDistance = distance
        frontier = next
        break
      }
    }
    frontier = next
    if (foundDistance >= 0) break
  }

  if (foundDistance < 0) return { matches: [], degraded: true }

  const matches: Match[] = []
  let x = n
  let y = m
  for (let distance = foundDistance; distance > 0; distance--) {
    const previous = trace[distance]
    const diagonal = x - y
    const index = offset + diagonal
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && previous[index - 1] < previous[index + 1])
        ? diagonal + 1
        : diagonal - 1
    const previousX = previous[offset + previousDiagonal]
    const previousY = previousX - previousDiagonal

    while (x > previousX && y > previousY) {
      matches.push({ oldIndex: x - 1, newIndex: y - 1 })
      x--
      y--
    }
    x = previousX
    y = previousY
  }
  while (x > 0 && y > 0) {
    matches.push({ oldIndex: x - 1, newIndex: y - 1 })
    x--
    y--
  }
  matches.reverse()
  return { matches, degraded: false }
}

export function computeLineDiff(
  oldContent: string,
  newContent: string,
  options?: {
    oldStartLine?: number
    newStartLine?: number
    editDistanceLimit?: number
  }
): LineDiffResult {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const { prefix, suffix } = trimCommonEdges(oldLines, newLines)
  const coreOld = oldLines.slice(prefix, oldLines.length - suffix)
  const coreNew = newLines.slice(prefix, newLines.length - suffix)
  const core = findMyersMatches(
    coreOld,
    coreNew,
    options?.editDistanceLimit ?? DEFAULT_EDIT_DISTANCE_LIMIT
  )

  const matches: Match[] = []
  for (let i = 0; i < prefix; i++) matches.push({ oldIndex: i, newIndex: i })
  for (const match of core.matches) {
    matches.push({ oldIndex: prefix + match.oldIndex, newIndex: prefix + match.newIndex })
  }
  for (let i = 0; i < suffix; i++) {
    matches.push({
      oldIndex: oldLines.length - suffix + i,
      newIndex: newLines.length - suffix + i
    })
  }

  const lines: LineDiffEntry[] = []
  let oldIndex = 0
  let newIndex = 0
  let oldLineNum = options?.oldStartLine ?? 1
  let newLineNum = options?.newStartLine ?? oldLineNum
  let added = 0
  let deleted = 0

  for (const match of matches) {
    while (oldIndex < match.oldIndex) {
      lines.push({ type: 'deleted', content: oldLines[oldIndex++], oldLineNum: oldLineNum++ })
      deleted++
    }
    while (newIndex < match.newIndex) {
      lines.push({ type: 'added', content: newLines[newIndex++], newLineNum: newLineNum++ })
      added++
    }
    lines.push({
      type: 'unchanged',
      content: oldLines[oldIndex],
      oldLineNum: oldLineNum++,
      newLineNum: newLineNum++
    })
    oldIndex++
    newIndex++
  }

  while (oldIndex < oldLines.length) {
    lines.push({ type: 'deleted', content: oldLines[oldIndex++], oldLineNum: oldLineNum++ })
    deleted++
  }
  while (newIndex < newLines.length) {
    lines.push({ type: 'added', content: newLines[newIndex++], newLineNum: newLineNum++ })
    added++
  }

  const largestLineNumber = Math.max(
    (options?.oldStartLine ?? 1) + oldLines.length - 1,
    (options?.newStartLine ?? options?.oldStartLine ?? 1) + newLines.length - 1
  )

  return {
    lines,
    added,
    deleted,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    lineNumberWidth: String(largestLineNumber).length,
    degraded: core.degraded
  }
}

export function formatDiffLineNumber(value: number | undefined, width: number): string {
  return value === undefined ? ' '.repeat(width) : String(value).padStart(width)
}
