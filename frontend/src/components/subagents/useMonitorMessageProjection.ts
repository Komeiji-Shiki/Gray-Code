import { computed, shallowRef, watch, type Ref } from 'vue'
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
  const projection = shallowRef<{
    run?: SubAgentRunSnapshot
    window?: SubAgentRunContentWindow
    rows: MonitorContentRow[]
    floors: Map<string, number>
  }>({ rows: [], floors: new Map() })
  // 数据更新在组件渲染前合并为一个投影版本；派生读取不再驱动可变索引。
  watch([run, window, active], ([current, contentWindow, isActive]) => {
    if (current?.runId !== projection.value.run?.runId) cache.clear()
    if (!current) {
      projection.value = { rows: [], floors: new Map() }
      return
    }
    index.synchronize(current, contentWindow)
    const streamingIndex = isActive && current.status === 'running' ? current.streamingContentIndex : null
    projection.value = {
      run: current,
      window: contentWindow,
      rows: index.displayRows(contentWindow, streamingIndex),
      floors: index.floors(contentWindow, streamingIndex),
    }
  }, { immediate: true })
  const rows = computed(() => projection.value.rows)
  const floorByMessageId = computed(() => projection.value.floors)
  function render(visible: readonly MonitorContentRow[]) {
    const current = projection.value.run
    if (!current) return []
    const retained = new Set(visible.filter(row => row.offset >= 0).map(row => row.backendIndex))
    // 在完整一轮投影后按挂载范围清理，避免顺序扫描中的 FIFO 污染及超限整表删除。
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key)
    return renderMonitorMessages(current, projection.value.window, overlay.value, active.value, cache, {
      offsets: visible.filter(row => row.offset >= 0).map(row => row.offset),
      includePlaceholder: visible.some(row => row.offset < 0),
      responses: index.responses,
      responseParts: index.responseParts,
    })
  }
  return { rows, floorByMessageId, render }
}
