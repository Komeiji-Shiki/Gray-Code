import type { SubAgentContextCompactionRecord } from '@shared/subAgentContextCompaction'
import type { Message } from '../../types'

export type SubAgentMonitorTimelineEntry =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'compaction'; key: string; record: SubAgentContextCompactionRecord }

export function upsertContextCompactionRecord(
  records: SubAgentContextCompactionRecord[] | undefined,
  incoming: SubAgentContextCompactionRecord | undefined
): SubAgentContextCompactionRecord[] {
  if (!incoming?.id) return records || []
  const current = records || []
  const index = current.findIndex(record => record.id === incoming.id)
  if (index < 0) return [...current, incoming].sort((a, b) => a.sequence - b.sequence)
  const next = [...current]
  next[index] = { ...next[index], ...incoming }
  return next.sort((a, b) => a.sequence - b.sequence)
}

export function latestContextCompaction(
  records: SubAgentContextCompactionRecord[] | undefined
): SubAgentContextCompactionRecord | undefined {
  if (!records?.length) return undefined
  return [...records].sort((a, b) => b.sequence - a.sequence)[0]
}

export function latestContextBoundaryCompaction(
  records: SubAgentContextCompactionRecord[] | undefined
): SubAgentContextCompactionRecord | undefined {
  if (!records?.length) return undefined
  return [...records]
    .filter(record =>
      (record.status === 'completed' || record.status === 'fallback')
      && typeof record.boundaryContentIndex === 'number'
    )
    .sort((a, b) => b.sequence - a.sequence)[0]
}

/**
 * 把当前 provider 上下文边界投影到已加载的 Monitor transcript window。
 * 边界不在当前分页窗口内时不伪造位置；用户加载到对应页后会自然出现。
 */
export function buildContextCompactionTimeline(
  messages: Message[],
  record: SubAgentContextCompactionRecord | undefined,
  windowStartIndex: number,
  windowEndIndex: number
): SubAgentMonitorTimelineEntry[] {
  const entries: SubAgentMonitorTimelineEntry[] = []
  const boundary = record?.boundaryContentIndex
  const boundaryVisible = typeof boundary === 'number'
    && boundary >= windowStartIndex
    && boundary <= windowEndIndex
  let markerInserted = false

  for (const message of messages) {
    const backendIndex = typeof message.backendIndex === 'number' ? message.backendIndex : undefined
    if (boundaryVisible && !markerInserted && backendIndex !== undefined && backendIndex >= boundary!) {
      entries.push({ kind: 'compaction', key: `compaction:${record!.id}`, record: record! })
      markerInserted = true
    }
    entries.push({ kind: 'message', key: `message:${message.id}`, message })
  }

  if (boundaryVisible && !markerInserted) {
    entries.push({ kind: 'compaction', key: `compaction:${record!.id}`, record: record! })
  }
  return entries
}
