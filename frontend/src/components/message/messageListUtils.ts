export interface ComputeVirtualRowsOptions {
  threshold: number
  estimatedRowHeight: number
  overscan: number
  viewportHeight: number
  scrollTop: number
}

export interface ComputeVirtualRowsResult<T> {
  rows: T[]
  topPadding: number
  bottomPadding: number
  startIndex: number
  endIndex: number
  virtualized: boolean
  fallback: boolean
  reason?: 'below_threshold' | 'invalid_estimate' | 'invalid_viewport' | 'empty_slice' | 'clamped'
}

/**
 * 将消息窗口向后移动一个步长，并限制在可用范围内。
 * 仅移动窗口，不把它直接贴到对话尾部，供滚动到底部时逐步阅读历史。
 */
export function advanceMessageWindowStart(
  currentStart: number,
  windowSize: number,
  totalRows: number,
  step: number
): number {
  const total = Number.isFinite(totalRows) ? Math.max(0, Math.floor(totalRows)) : 0
  const size = Number.isFinite(windowSize) ? Math.max(0, Math.floor(windowSize)) : 0
  const current = Number.isFinite(currentStart) ? Math.max(0, Math.floor(currentStart)) : 0
  const increment = Number.isFinite(step) ? Math.max(0, Math.floor(step)) : 0
  const maxStart = Math.max(0, total - size)

  return Math.min(maxStart, current + increment)
}

export function resolveLoadedVisibleMessages<T>(messages: T[], visibleCount: number): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return []
  // 尾部窗口切片：仅取最近 visibleCount 条消息参与 enhance/重排，
  // 避免旧消息在每 chunk 都被重新计算导致性能退化
  const count = Math.max(1, typeof visibleCount === 'number' && Number.isFinite(visibleCount) ? visibleCount : 1)
  if (messages.length <= count) return messages
  return messages.slice(messages.length - count)
}

export function computeVirtualRows<T>(rows: T[], options: ComputeVirtualRowsOptions): ComputeVirtualRowsResult<T> {
  const totalRows = Array.isArray(rows) ? rows.length : 0
  if (totalRows === 0) {
    return {
      rows: [],
      topPadding: 0,
      bottomPadding: 0,
      startIndex: 0,
      endIndex: 0,
      virtualized: false,
      fallback: false,
      reason: 'below_threshold'
    }
  }

  if (totalRows <= options.threshold) {
    return {
      rows,
      topPadding: 0,
      bottomPadding: 0,
      startIndex: 0,
      endIndex: totalRows,
      virtualized: false,
      fallback: false,
      reason: 'below_threshold'
    }
  }

  if (!Number.isFinite(options.estimatedRowHeight) || options.estimatedRowHeight <= 0) {
    return {
      rows,
      topPadding: 0,
      bottomPadding: 0,
      startIndex: 0,
      endIndex: totalRows,
      virtualized: false,
      fallback: true,
      reason: 'invalid_estimate'
    }
  }

  if (!Number.isFinite(options.viewportHeight) || options.viewportHeight <= 0) {
    return {
      rows,
      topPadding: 0,
      bottomPadding: 0,
      startIndex: 0,
      endIndex: totalRows,
      virtualized: false,
      fallback: true,
      reason: 'invalid_viewport'
    }
  }

  const overscan = Math.max(0, Math.floor(options.overscan))
  const visibleRows = Math.max(1, Math.ceil(options.viewportHeight / options.estimatedRowHeight))
  const sliceLength = visibleRows + overscan * 2
  const rawStartIndex = Math.max(0, Math.floor((Number.isFinite(options.scrollTop) ? options.scrollTop : 0) / options.estimatedRowHeight) - overscan)
  const maxStartIndex = Math.max(0, totalRows - sliceLength)
  const startIndex = Math.min(rawStartIndex, maxStartIndex)
  const endIndex = Math.min(totalRows, startIndex + sliceLength)
  const visibleSlice = rows.slice(startIndex, endIndex)

  if (visibleSlice.length === 0) {
    return {
      rows,
      topPadding: 0,
      bottomPadding: 0,
      startIndex: 0,
      endIndex: totalRows,
      virtualized: false,
      fallback: true,
      reason: 'empty_slice'
    }
  }

  return {
    rows: visibleSlice,
    topPadding: Math.max(0, startIndex * options.estimatedRowHeight),
    bottomPadding: Math.max(0, (totalRows - endIndex) * options.estimatedRowHeight),
    startIndex,
    endIndex,
    virtualized: true,
    fallback: false,
    reason: rawStartIndex !== startIndex ? 'clamped' : undefined
  }
}

/**
 * 计算楼层号映射：用户消息与模型回复各占一楼（按消息顺序依次编号）。
 *
 * tool 消息与 functionResponse 工具结果不占楼；总结消息 role 为 user，正常计入，
 * 保证楼层号连续。返回 Map<messageId, floor>。
 */
export function isNumberedMessage(message: { role: string; isFunctionResponse?: boolean }): boolean {
  return !message.isFunctionResponse && (message.role === 'user' || message.role === 'assistant')
}

export function computeMessageFloorMap<T extends { id: string; role: string; isFunctionResponse?: boolean }>(messages: T[]): Map<string, number> {
  const map = new Map<string, number>()
  let floor = 0
  for (const message of messages) {
    if (isNumberedMessage(message)) {
      floor++
      map.set(message.id, floor)
    }
  }
  return map
}

/**
 * 分页窗口的楼层由后端全局索引决定；窗口后新增的消息仅在索引连续时顺延。
 * 全局索引尚未载入时，只允许从历史起点加载的窗口自行编号，避免尾页错误地从 1 开始。
 */
export function computePaginatedMessageFloorMap<T extends { id: string; role: string; isFunctionResponse?: boolean; backendIndex?: number }>(
  messages: T[], floorIndices: readonly number[] | null, snapshotTotal: number
): Map<string, number> {
  if (floorIndices === null) {
    return messages[0]?.backendIndex === 0 ? computeMessageFloorMap(messages) : new Map()
  }
  const floorAt = (index: number): number | undefined => {
    let low = 0
    let high = floorIndices.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (floorIndices[middle] === index) return middle + 1
      if (floorIndices[middle] < index) low = middle + 1
      else high = middle - 1
    }
    return undefined
  }
  const result = new Map<string, number>()
  let nextIndex = snapshotTotal
  let nextFloor = floorIndices.length
  let contiguous = true
  let reachedSnapshotTail = snapshotTotal === 0
  for (const message of messages) {
    const index = message.backendIndex
    if (typeof index === 'number' && index < snapshotTotal) {
      if (index === snapshotTotal - 1) reachedSnapshotTail = true
      if (isNumberedMessage(message)) {
        // 快照内的位置以全局索引为准（权威值覆盖之前可能存在的占位编号）。
        const floor = floorAt(index)
        if (floor !== undefined) result.set(message.id, floor)
      }
      continue
    }
    if (typeof index === 'number') {
      if (index !== nextIndex) contiguous = false
      if (!contiguous) continue
      // 同一条消息已按占位编号过时保持原号：消息拿到持久化索引后不该再占一格，
      // 否则自身号偏大，后续新消息的号也会跟着整体前移。
      if (isNumberedMessage(message) && !result.has(message.id)) result.set(message.id, ++nextFloor)
      nextIndex++
      continue
    }
    // 流式本地占位紧跟已知尾部时，沿用即将写入的楼层号。
    if (contiguous && reachedSnapshotTail && isNumberedMessage(message) && !result.has(message.id)) {
      result.set(message.id, ++nextFloor)
    }
  }
  return result
}

/**
 * 计算存档序号映射：按创建时间升序编号（第 N 次存档）。
 *
 * 同时间戳时按消息索引 / before-先 稳定排序（checkpoint 列表顺序无契约，必须显式定序）。
 * 返回 Map<checkpointId, 序号>。
 */
export function computeCheckpointFloorMap<T extends { id: string; timestamp: number; messageIndex: number; phase: string }>(checkpoints: T[]): Map<string, number> {
  const sorted = [...checkpoints]
  sorted.sort((a, b) =>
    a.timestamp - b.timestamp
    || a.messageIndex - b.messageIndex
    || (a.phase === 'before' ? 0 : 1) - (b.phase === 'before' ? 0 : 1)
  )
  const map = new Map<string, number>()
  let seq = 0
  for (const cp of sorted) {
    seq++
    map.set(cp.id, seq)
  }
  return map
}
