import { computed, watch, type Ref } from 'vue'
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
  let index = new MonitorContentIndex()
  const cache = new Map<number, MonitorRenderCacheEntry>()
  watch(() => run.value?.runId, () => {
    // 只保留当前查看任务的挂载工作集，切换任务即可释放旧 Message 与索引。
    index = new MonitorContentIndex()
    cache.clear()
  }, { flush: 'sync' })
  const streamingIndex = () => active.value && run.value?.status === 'running' ? run.value.streamingContentIndex : null
  const rows = computed(() => {
    if (!run.value) return []
    index.synchronize(run.value, window.value)
    return index.displayRows(window.value, streamingIndex())
  })
  const floorByMessageId = computed(() => {
    if (!run.value) return new Map<string, number>()
    index.synchronize(run.value, window.value)
    return index.floors(window.value, streamingIndex())
  })
  function render(visible: readonly MonitorContentRow[]) {
    const current = run.value
    if (!current) return []
    index.synchronize(current, window.value)
    const retained = new Set(visible.filter(row => row.offset >= 0).map(row => row.backendIndex))
    // 在完整一轮投影后按挂载范围清理，避免顺序扫描中的 FIFO 污染及超限整表删除。
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key)
    return renderMonitorMessages(current, window.value, overlay.value, active.value, cache, {
      offsets: visible.filter(row => row.offset >= 0).map(row => row.offset),
      includePlaceholder: visible.some(row => row.offset < 0),
      responses: index.responses,
      responseParts: index.responseParts,
    })
  }
  return { rows, floorByMessageId, render }
}
