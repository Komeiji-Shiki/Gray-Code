import { ref, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useSettingsStore } from '@/stores/settingsStore'
import type { UsageStatsResult, UsageTimeRange } from '@/types/usage'

/**
 * SettingsPanel「用量统计（Token 用量摘要）」区块的领域逻辑（S7 批次拆分，纯重构，行为零变化）。
 */
export function useUsageStats() {
  const settingsStore = useSettingsStore()

  const usageStats = ref<UsageStatsResult | null>(null)
  const usageRange = ref<UsageTimeRange>('all')
  const usageLoading = ref(false)
  const usageLoadError = ref('')
  // 用量统计请求序号：慢响应到达时若已被更新的请求取代，直接丢弃（仿 validateStoragePath 的 pathValidationRequestId）
  let usageStatsRequestId = 0

  /** 快捷范围 → 起始时间（本地 00:00 对齐；'all' 不限制） */
  function usageRangeToStartTime(range: UsageTimeRange): number | undefined {
    if (range === 'all') return undefined
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    if (range === 'today') return startOfToday.getTime()
    const days = range === '7d' ? 6 : 29
    return startOfToday.getTime() - days * 24 * 60 * 60 * 1000
  }

  async function loadUsageStats() {
    const requestId = ++usageStatsRequestId
    usageLoading.value = true
    usageLoadError.value = ''
    try {
      const startTime = usageRangeToStartTime(usageRange.value)
      const query: Record<string, unknown> = startTime !== undefined ? { startTime } : {}
      const result = await sendToExtension<UsageStatsResult>(MESSAGE_NAMES['usage.getStats'], query)
      // 仅采纳最新一次请求的响应：慢响应不得覆盖新范围/新页签触发的加载结果
      if (requestId === usageStatsRequestId) {
        usageStats.value = result
      }
    } catch (error) {
      if (requestId === usageStatsRequestId) {
        usageLoadError.value = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (requestId === usageStatsRequestId) {
        usageLoading.value = false
      }
    }
  }

  // 切换时间范围时重新聚合
  watch(usageRange, () => loadUsageStats())

  // 进入“用量统计”页签时刷新数据
  watch(() => settingsStore.activeTab, (tab) => {
    if (tab === 'usage') loadUsageStats()
  })

  return { usageStats, usageRange, usageLoading, usageLoadError, loadUsageStats }
}
