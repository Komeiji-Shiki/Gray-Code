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
 * tool 消息（工具调用/结果）与内部消息不占楼；总结消息 role 为 user，正常计入，
 * 保证楼层号连续。返回 Map<messageId, floor>。
 */
export function computeMessageFloorMap<T extends { id: string; role: string }>(messages: T[]): Map<string, number> {
  const map = new Map<string, number>()
  let floor = 0
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      floor++
      map.set(message.id, floor)
    }
  }
  return map
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
