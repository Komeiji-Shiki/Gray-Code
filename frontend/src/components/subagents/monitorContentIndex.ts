import type { Content, ContentPart } from '@/types'
import { getStreamContentChangeStart } from '@/stores/agentRun/contentDelta'
import { computePaginatedMessageFloorMap } from '../message/messageListUtils'
import { floorMessage, type MonitorMessageSource } from './monitorMessages'
import type { SubAgentRunContentWindowState } from './monitorWindowState'

export interface MonitorContentRow {
  id: string
  /** 持久消息 ID 在删除后的全局索引重排中仍然稳定；旧记录可缺省。 */
  anchorId?: string
  backendIndex: number
  /** -1 是尚未收到首个 delta 的模型占位楼层。 */
  offset: number
}
type FloorRow = ReturnType<typeof floorMessage>
type Response = NonNullable<ContentPart['functionResponse']>
interface ResponseOwner { offset: number; response: Response; parts: ContentPart[] }

/** 已加载窗口的轻量索引；只有 reducer 明确保持的前缀可以增量复用。 */
export class MonitorContentIndex {
  readonly responses = new Map<string, Response>()
  readonly responseParts = new Map<string, ContentPart[]>()
  private readonly responseOwners = new Map<string, ResponseOwner[]>()
  private responseIdsByOffset: string[][] = []
  private contents?: Content[]
  private runId = ''
  private startIndex = 0
  private floorRows: FloorRow[] = []
  private anchorIds: Array<string | undefined> = []
  private rows: MonitorContentRow[] = []
  private floorVersion = 0
  private displayCache?: { rows: MonitorContentRow[]; placeholder?: number; result: MonitorContentRow[] }
  private floorCache?: {
    version: number; indices?: number[]; total: number; placeholder?: number; result: Map<string, number>
  }

  synchronize(run: MonitorMessageSource, window: SubAgentRunContentWindowState | undefined): void {
    const contents = run.contents
    const startIndex = window?.startIndex ?? 0
    if (this.contents === contents && this.runId === run.runId && this.startIndex === startIndex) return
    const sameWindow = this.runId === run.runId && this.startIndex === startIndex
    const changedFrom = sameWindow && this.contents ? getStreamContentChangeStart(this.contents, contents) : undefined
    const start = changedFrom ?? 0
    if (changedFrom === undefined) {
      this.responses.clear()
      this.responseParts.clear()
      this.responseOwners.clear()
      this.responseIdsByOffset = []
    } else {
      // 保持重复工具 ID 的最后一个结果获胜；删除变化后缀时恢复前面的同 ID 结果。
      const changedIds = new Set<string>()
      for (let offset = start; offset < this.responseIdsByOffset.length; offset++) {
        for (const id of this.responseIdsByOffset[offset]) changedIds.add(id)
      }
      for (const id of changedIds) {
        const owners = this.responseOwners.get(id)!
        while (owners.length && owners[owners.length - 1].offset >= start) owners.pop()
        const owner = owners[owners.length - 1]
        if (owner) {
          this.responses.set(id, owner.response)
          this.responseParts.set(id, owner.parts)
        } else {
          this.responseOwners.delete(id)
          this.responses.delete(id)
          this.responseParts.delete(id)
        }
      }
      this.responseIdsByOffset.length = start
    }

    let structureChanged = !sameWindow || this.floorRows.length !== contents.length
    for (let offset = start; offset < contents.length; offset++) {
      const content = contents[offset]
      const row = floorMessage(content, run.runId, content.index ?? startIndex + offset)
      const previous = this.floorRows[offset]
      if (this.anchorIds[offset] !== content.id) structureChanged = true
      this.anchorIds[offset] = content.id
      if (!previous || previous.id !== row.id || previous.role !== row.role || previous.isFunctionResponse !== row.isFunctionResponse) {
        this.floorRows[offset] = row
        structureChanged = true
      }
      const ids = new Set<string>()
      for (const part of content.parts) {
        const response = part.functionResponse
        if (!response?.id) continue
        const owners = this.responseOwners.get(response.id) ?? []
        owners.push({ offset, response, parts: content.parts })
        this.responseOwners.set(response.id, owners)
        this.responses.set(response.id, response)
        this.responseParts.set(response.id, content.parts)
        ids.add(response.id)
      }
      this.responseIdsByOffset[offset] = [...ids]
    }
    this.floorRows.length = contents.length
    this.anchorIds.length = contents.length
    if (structureChanged) {
      this.rows = this.floorRows.flatMap((row, offset) => row.isFunctionResponse ? [] : [{
        id: row.id, anchorId: this.anchorIds[offset], backendIndex: row.backendIndex, offset,
      }])
      this.floorVersion++
    }
    this.contents = contents
    this.runId = run.runId
    this.startIndex = startIndex
  }

  private placeholder(window: SubAgentRunContentWindowState | undefined, streamingIndex?: number | null): number | undefined {
    return window && streamingIndex === window.totalCount && window.endIndex === window.totalCount ? streamingIndex : undefined
  }

  displayRows(window: SubAgentRunContentWindowState | undefined, streamingIndex?: number | null): MonitorContentRow[] {
    const placeholder = this.placeholder(window, streamingIndex)
    if (this.displayCache?.rows === this.rows && this.displayCache.placeholder === placeholder) return this.displayCache.result
    const result = placeholder === undefined ? this.rows : [...this.rows,
      { id: `${this.runId}_${placeholder}`, backendIndex: placeholder, offset: -1 }]
    this.displayCache = { rows: this.rows, placeholder, result }
    return result
  }

  floors(window: SubAgentRunContentWindowState | undefined, streamingIndex?: number | null): Map<string, number> {
    const indices = window?.floorIndices
    const total = window?.totalCount ?? 0
    const placeholder = this.placeholder(window, streamingIndex)
    const cached = this.floorCache
    if (cached?.version === this.floorVersion && cached.indices === indices && cached.total === total && cached.placeholder === placeholder) {
      return cached.result
    }
    const rows = placeholder === undefined ? this.floorRows : [...this.floorRows,
      { id: `${this.runId}_${placeholder}`, backendIndex: placeholder, role: 'assistant', isFunctionResponse: false }]
    const result = computePaginatedMessageFloorMap(rows, indices ?? null, total)
    this.floorCache = { version: this.floorVersion, indices, total, placeholder, result }
    return result
  }
}
