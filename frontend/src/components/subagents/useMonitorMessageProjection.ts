import { computed, type Ref } from 'vue'
import { MonitorContentIndex, type MonitorContentRow } from './monitorContentIndex'
import { renderMonitorMessages, type MonitorRenderCacheEntry } from './monitorMessages'
import type { MonitorToolStatusOverlay } from './monitorToolStatusOverlay'
import type { SubAgentRunContentWindow, SubAgentRunSnapshot } from './monitorTypes'

export function useMonitorMessageProjection(
  run: Readonly<Ref<SubAgentRunSnapshot | undefined>>,
  window: Readonly<Ref<SubAgentRunContentWindow | undefined>>,
  overlay: Readonly<Ref<MonitorToolStatusOverlay | undefined>>,
  active: Readonly<Ref<boolean>>
) {
  const index = new MonitorContentIndex()
  const cache = new Map<number, MonitorRenderCacheEntry>()
  // 投影首次读取时同步计算；同一源版本的行、楼层和渲染共用索引，分页后可立即定位新行。
  const projection = computed<{
    run?: SubAgentRunSnapshot
    window?: SubAgentRunContentWindow
    rows: MonitorContentRow[]
    floors: Map<string, number>
  }>(previous => {
    const current = run.value
    const contentWindow = window.value
    const isActive = active.value
    if (current?.runId !== previous?.run?.runId) cache.clear()
    if (!current) return { rows: [], floors: new Map() }
    index.synchronize(current, contentWindow)
    const streamingIndex = isActive && current.status === 'running' ? current.streamingContentIndex : null
    return {
      run: current,
      window: contentWindow,
      rows: index.displayRows(contentWindow, streamingIndex),
      floors: index.floors(contentWindow, streamingIndex),
    }
  })
  const rows = computed(() => projection.value.rows)
  const floorByMessageId = computed(() => projection.value.floors)
  function render(visible: readonly MonitorContentRow[]) {
    const projected = projection.value
    const current = projected.run
    if (!current) return []
    const retained = new Set(visible.filter(row => row.offset >= 0).map(row => row.backendIndex))
    // 在完整一轮投影后按挂载范围清理，避免顺序扫描中的 FIFO 污染及超限整表删除。
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key)
    return renderMonitorMessages(current, projected.window, overlay.value, active.value, cache, {
      offsets: visible.filter(row => row.offset >= 0).map(row => row.offset),
      includePlaceholder: visible.some(row => row.offset < 0),
      responses: index.responses,
      responseParts: index.responseParts,
    })
  }
  return { rows, floorByMessageId, render }
}
