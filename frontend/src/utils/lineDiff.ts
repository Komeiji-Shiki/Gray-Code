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

export interface LineDiffOptions {
  oldStartLine?: number
  newStartLine?: number
  editDistanceLimit?: number
}

interface Match {
  oldIndex: number
  newIndex: number
}

const DEFAULT_EDIT_DISTANCE_LIMIT = 768

/**
 * Myers 主循环的编辑距离预算上限：trace 逐层保存 frontier，内存为 O(limit²)。
 * 调用方传入超大 editDistanceLimit 时钳制到此值，避免 trace 内存失控。
 */
const MAX_EDIT_DISTANCE_LIMIT = 4096

/**
 * 按 (oldContent, newContent, 起始行, 预算) 缓存最近一次行级差分结果。
 * 字符串以值相等比较（JS 字符串不可区分引用，值相等即视为同一输入），
 * 返回同一结果对象引用：组件流式更新/重渲染时不再重复 Myers 计算，
 * 下游虚拟列表收到的 props 引用也保持稳定。
 *
 * 共享只读契约：命中缓存时返回的对象（含 result.lines 数组）为共享引用，
 * 消费方不得 mutate（增删行/改字段都会污染缓存并影响其他消费方）；
 * 需要修改时先复制（如 lines.slice() / 展开对象）。
 */
const MAX_CACHE_ENTRIES = 32

interface CachedLineDiff {
  oldContent: string
  newContent: string
  oldStartLine: number
  newStartLine: number
  editDistanceLimit: number
  result: LineDiffResult
}

const diffResultCache: CachedLineDiff[] = []

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

/**
 * 快速失败：新旧核心区域完全没有公共行时（大文件整体重写场景），
 * 编辑距离必然超过任意预算，直接判定退化，跳过 Myers 主循环。
 * 结果与预算耗尽时的退化输出完全一致（matches 为空、整段核心标记为删除+新增）。
 */
function sharesAnyLine(oldIds: Int32Array, newIds: Int32Array): boolean {
  const [small, large] = oldIds.length <= newIds.length ? [oldIds, newIds] : [newIds, oldIds]
  const seen = new Set<number>()
  for (let i = 0; i < small.length; i++) seen.add(small[i])
  for (let i = 0; i < large.length; i++) {
    if (seen.has(large[i])) return true
  }
  return false
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
  // 预算同时受 n+m（距离上界）与调用方预算（含 MAX_EDIT_DISTANCE_LIMIT 钳制）约束
  const limit = Math.min(n + m, editDistanceLimit, MAX_EDIT_DISTANCE_LIMIT)
  // 快速失败：新旧核心区域完全没有公共行时，最小编辑距离即 n+m（全部删除+全部插入）。
  // 先判 n+m > limit 再查公共行：无公共行扫描是 O(n+m) 全量操作，预算已超时无需先执行；
  // 预算充足（n+m <= limit）时仍需走 Myers 以得到 degraded=false 的精确结果。
  if (n + m > limit && !sharesAnyLine(oldIds, newIds)) {
    return { matches: [], degraded: true }
  }
  // 第 d 层的 frontier 只覆盖对角线 [-d, d]，按层动态分配大小 2d+3：
  // 相比每层固定 2*limit+3，trace 总内存约为原来的 1/4。
  const trace: Int32Array[] = []
  let frontier = new Int32Array(3)
  let foundDistance = -1

  for (let distance = 0; distance <= limit; distance++) {
    trace.push(frontier)
    const next = new Int32Array(2 * distance + 3)
    const offset = distance + 1
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let x: number
      // 动态大小数组的 offset 随层变化：上一层的对角线上移一格，
      // 插入（k+1）的前驱位于 frontier[index]，删除（k-1）的前驱位于 frontier[index-2]。
      if (
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 2] < frontier[index])
      ) {
        x = frontier[index]
      } else {
        x = frontier[index - 2] + 1
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
    // trace[distance] 是第 distance-1 层的 frontier：对角线范围 [-(distance-1), distance-1]，
    // 数组大小 2*distance+1，offset 即 distance。
    const previous = trace[distance]
    const offset = distance
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
  options?: LineDiffOptions
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

/**
 * 带缓存的 computeLineDiff：同一对内容重复计算时直接返回上一次的结果对象引用。
 * 适用于组件在流式结果更新/重渲染期间反复求值的场景（hunk 内容字符串引用不变即可命中）。
 *
 * 共享只读契约：返回的 LineDiffResult 及其 lines 数组为共享对象（命中缓存时同一引用），
 * 消费方只读使用，不得 mutate；需要修改时先复制。缓存键中的预算同样受
 * MAX_EDIT_DISTANCE_LIMIT 钳制，与 findMyersMatches 的实际执行预算保持一致。
 */
export function computeLineDiffCached(
  oldContent: string,
  newContent: string,
  options?: LineDiffOptions
): LineDiffResult {
  const oldStartLine = options?.oldStartLine ?? 1
  const newStartLine = options?.newStartLine ?? oldStartLine
  const editDistanceLimit = Math.min(
    options?.editDistanceLimit ?? DEFAULT_EDIT_DISTANCE_LIMIT,
    MAX_EDIT_DISTANCE_LIMIT
  )

  for (let i = 0; i < diffResultCache.length; i++) {
    const entry = diffResultCache[i]
    if (
      entry.oldContent === oldContent &&
      entry.newContent === newContent &&
      entry.oldStartLine === oldStartLine &&
      entry.newStartLine === newStartLine &&
      entry.editDistanceLimit === editDistanceLimit
    ) {
      if (i > 0) {
        const [hit] = diffResultCache.splice(i, 1)
        diffResultCache.unshift(hit)
      }
      return entry.result
    }
  }

  const result = computeLineDiff(oldContent, newContent, {
    oldStartLine,
    newStartLine,
    editDistanceLimit
  })
  diffResultCache.unshift({
    oldContent,
    newContent,
    oldStartLine,
    newStartLine,
    editDistanceLimit,
    result
  })
  if (diffResultCache.length > MAX_CACHE_ENTRIES) {
    diffResultCache.length = MAX_CACHE_ENTRIES
  }
  return result
}

/**
 * 清空行级差分缓存。用于会话切换/长时间运行后的主动释放（大文件 diff 的 lines 可达数万 entry）。
 * 当前调用方：MessageList.vue 的 onBeforeUnmount（消息列表卸载即不再有 diff 面板消费方）。
 * 缓存本身有界（MAX_CACHE_ENTRIES），此函数只提供按需清空的入口，不影响自动淘汰语义。
 */
export function clearLineDiffCache(): void {
  diffResultCache.length = 0
}

export function formatDiffLineNumber(value: number | undefined, width: number): string {
  return value === undefined ? ' '.repeat(width) : String(value).padStart(width)
}
