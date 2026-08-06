<script setup lang="ts">
/**
 * UsageTimeSection - 使用时间统计区块
 *
 * 展示 GrayCode 的 IDE 活跃时间统计（数据来自后端 ActivityTracker）：
 * - 范围切换：近 7 天 / 近 30 天 / 近 90 天 / 近 1 年 / 全部（可翻看很久以前的记录）
 * - 总览卡片：今日已用 / 当前连续工作 / 范围内合计
 * - 每日使用时长条形图（近 7 / 30 天）
 * - 每月使用时长条形图（近 90 天及以上，点击月份展开该月每日明细）
 * - 作息热力网格（最近 7 天 × 24 小时，悬停查看该小时活跃分钟数）
 */

import { ref, computed, watch, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useSettingsStore } from '@/stores'
import { t } from '../../i18n'

interface ActivitySession {
  start: number
  end: number
  minutes: number
}

interface DayActivityStats {
  date: string
  totalMinutes: number
  sessionCount: number
  firstActiveAt: number | null
  lastActiveAt: number | null
  sessions: ActivitySession[]
  hourly: number[]
}

interface MonthlyActivityStats {
  month: string
  totalMinutes: number
  activeDays: number
  sessionCount: number
}

interface ActivityStatsResult {
  generatedAt: number
  today: DayActivityStats | null
  currentSession: { active: boolean; startedAt: number | null; minutes: number }
  daily: DayActivityStats[]
  hourlyHeatmap: Array<{ date: string; hours: number[] }>
  monthly: MonthlyActivityStats[]
}

type RangeId = '7d' | '30d' | '90d' | '365d' | 'all'

const settingsStore = useSettingsStore()

const isLoading = ref(false)
const loadError = ref('')
const stats = ref<ActivityStatsResult | null>(null)

const activeRange = ref<RangeId>('7d')

/** 展开查看每日明细的月份（YYYY-MM，空表示未展开） */
const expandedMonth = ref('')

const rangeOptions: Array<{ id: RangeId; label: string }> = [
  { id: '7d', label: t('components.usageTime.range7d') },
  { id: '30d', label: t('components.usageTime.range30d') },
  { id: '90d', label: t('components.usageTime.range90d') },
  { id: '365d', label: t('components.usageTime.range1y') },
  { id: 'all', label: t('components.usageTime.rangeAll') }
]

async function loadStats(force = false) {
  isLoading.value = true
  loadError.value = ''
  try {
    const query: Record<string, unknown> = {
      range: activeRange.value,
      includeHourly: true,
      includeMonthly: true
    }
    if (force) query.force = true
    stats.value = await sendToExtension<ActivityStatsResult>('activity.getStats', query)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

// 切换范围时收起月度明细
watch(activeRange, () => {
  expandedMonth.value = ''
  loadStats()
})

// 页面保活（v-show 切换）后重新进入时自动刷新
watch(() => settingsStore.currentView, (view) => {
  if (view === 'usage') loadStats()
})

onMounted(() => {
  loadStats()
})

// ==================== 派生数据 ====================

const todayMinutes = computed(() => stats.value?.today?.totalMinutes ?? 0)

const currentSessionMinutes = computed(() => {
  const s = stats.value?.currentSession
  return s?.active ? s.minutes : 0
})

const currentSessionActive = computed(() => stats.value?.currentSession?.active ?? false)

/** 当前范围合计：7d/30d 用每日求和，更长范围用月度求和 */
const rangeTotalMinutes = computed(() => {
  if (!stats.value) return 0
  if (activeRange.value === '7d' || activeRange.value === '30d') {
    return stats.value.daily.reduce((sum, d) => sum + d.totalMinutes, 0)
  }
  return stats.value.monthly.reduce((sum, m) => sum + m.totalMinutes, 0)
})

/** 每日条形图数据（按日期升序） */
const dailyList = computed(() => {
  const list = stats.value?.daily ?? []
  return [...list].reverse()
})

const maxDailyMinutes = computed(() =>
  Math.max(1, ...dailyList.value.map((d) => d.totalMinutes))
)

function barWidth(minutes: number, maxMinutes: number): string {
  return `${Math.max(2, Math.round((minutes / Math.max(1, maxMinutes)) * 100))}%`
}

/** 月度条形图数据（按月份倒序，最新在前） */
const monthlyList = computed(() => stats.value?.monthly ?? [])

const maxMonthlyMinutes = computed(() =>
  Math.max(1, ...monthlyList.value.map((m) => m.totalMinutes))
)

/** 展开月份的每日明细（按日期升序） */
const expandedMonthDays = computed(() => {
  if (!expandedMonth.value || !stats.value) return []
  return stats.value.daily
    .filter((d) => d.date.startsWith(expandedMonth.value))
    .reverse()
})

/** 热力网格：最近 7 天 × 24 小时（日期升序） */
const heatmapRows = computed(() => (stats.value?.hourlyHeatmap ?? []).slice(-7))

/** 当前热力最大值（归一化透明度用） */
const maxHourMinutes = computed(() =>
  Math.max(1, ...heatmapRows.value.flatMap((row) => row.hours))
)

function cellOpacity(minutes: number): number {
  if (minutes <= 0) return 0.08
  return 0.25 + 0.75 * (minutes / maxHourMinutes.value)
}

function dayLabel(date: string): string {
  const [, m, d] = date.split('-')
  return `${m}-${d}`
}

/** 月份短标签：2026-08 → 26-08 */
function monthLabel(month: string): string {
  return month.slice(2)
}

function toggleMonth(month: string): void {
  expandedMonth.value = expandedMonth.value === month ? '' : month
}

/** 完整时长文案：3小时20分钟 */
function formatDuration(minutes: number): string {
  if (minutes <= 0) return `0${t('components.usageTime.minutes')}`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}${t('components.usageTime.minutes')}`
  if (m === 0) return `${h}${t('components.usageTime.hours')}`
  return t('components.usageTime.durationHM', { hours: h, minutes: m })
}

/** 短时长文案（条形图数值）：2h / 45m */
function formatShort(minutes: number): string {
  if (minutes <= 0) return '0'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}${t('components.usageTime.shortMinute')}`
  if (m === 0) return `${h}${t('components.usageTime.shortHour')}`
  return `${h}${t('components.usageTime.shortHour')} ${m}${t('components.usageTime.shortMinute')}`
}
</script>

<template>
  <div class="usage-time-section">
    <div class="time-header">
      <span class="time-title">{{ t('components.usageTime.title') }}</span>
      <button class="time-refresh" :title="t('components.usageTime.refresh')" :disabled="isLoading" @click="loadStats(true)">
        <i class="codicon codicon-refresh"></i>
      </button>
    </div>

    <!-- 范围切换 -->
    <div class="time-range-bar">
      <button
        v-for="option in rangeOptions"
        :key="option.id"
        :class="['time-range-btn', { active: activeRange === option.id }]"
        :disabled="isLoading"
        @click="activeRange = option.id"
      >
        {{ option.label }}
      </button>
    </div>

    <div v-if="isLoading" class="time-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.usageTime.loading') }}</span>
    </div>

    <div v-else-if="loadError" class="time-state is-error">
      <i class="codicon codicon-error"></i>
      <span>{{ t('components.usageTime.loadFailed') }}</span>
    </div>

    <template v-else-if="stats">
      <!-- 总览卡片 -->
      <div class="time-totals">
        <div class="time-total-item">
          <span class="time-total-value">{{ formatDuration(todayMinutes) }}</span>
          <span class="time-total-label">{{ t('components.usageTime.today') }}</span>
        </div>
        <div class="time-total-item">
          <span class="time-total-value" :class="{ 'is-active': currentSessionActive }">
            {{ currentSessionActive ? formatDuration(currentSessionMinutes) : '—' }}
          </span>
          <span class="time-total-label">{{ t('components.usageTime.currentSession') }}</span>
        </div>
        <div class="time-total-item">
          <span class="time-total-value">{{ formatDuration(rangeTotalMinutes) }}</span>
          <span class="time-total-label">{{ t('components.usageTime.totalInRange') }}</span>
        </div>
      </div>

      <!-- 每日使用时长（近 7 / 30 天） -->
      <div v-if="activeRange === '7d' || activeRange === '30d'" class="time-block">
        <span class="time-block-title">{{ t('components.usageTime.dailyTitle') }}</span>
        <div v-if="dailyList.length > 0" class="time-daily">
          <div v-for="day in dailyList" :key="day.date" class="time-day">
            <span class="time-day-label">{{ dayLabel(day.date) }}</span>
            <div class="time-day-track">
              <div
                class="time-day-bar"
                :style="{ width: barWidth(day.totalMinutes, maxDailyMinutes) }"
                :title="`${day.date}: ${formatDuration(day.totalMinutes)}`"
              ></div>
            </div>
            <span class="time-day-value">{{ formatShort(day.totalMinutes) }}</span>
          </div>
        </div>
        <div v-else class="time-block-empty">{{ t('components.usageTime.empty') }}</div>
      </div>

      <!-- 每月使用时长（近 90 天及以上，点击月份展开每日明细） -->
      <div v-else class="time-block">
        <span class="time-block-title">{{ t('components.usageTime.monthlyTitle') }}</span>
        <div v-if="monthlyList.length > 0" class="time-monthly">
          <div
            v-for="item in monthlyList"
            :key="item.month"
            :class="['time-month', { expanded: expandedMonth === item.month }]"
          >
            <div
              class="time-month-row"
              :title="t('components.usageTime.expandMonth')"
              @click="toggleMonth(item.month)"
            >
              <span class="time-month-label">{{ monthLabel(item.month) }}</span>
              <div class="time-day-track">
                <div
                  class="time-day-bar"
                  :style="{ width: barWidth(item.totalMinutes, maxMonthlyMinutes) }"
                ></div>
              </div>
              <span class="time-month-value">{{ formatShort(item.totalMinutes) }}</span>
              <span class="time-month-days">{{ t('components.usageTime.monthActiveDays', { days: item.activeDays }) }}</span>
              <i class="codicon" :class="expandedMonth === item.month ? 'codicon-chevron-up' : 'codicon-chevron-down'"></i>
            </div>

            <!-- 展开：该月每日明细 -->
            <div v-if="expandedMonth === item.month" class="time-month-detail">
              <div v-for="day in expandedMonthDays" :key="day.date" class="time-day">
                <span class="time-day-label">{{ dayLabel(day.date) }}</span>
                <div class="time-day-track">
                  <div
                    class="time-day-bar"
                    :style="{ width: barWidth(day.totalMinutes, maxDailyMinutes) }"
                    :title="`${day.date}: ${formatDuration(day.totalMinutes)}`"
                  ></div>
                </div>
                <span class="time-day-value">{{ formatShort(day.totalMinutes) }}</span>
              </div>
              <div v-if="expandedMonthDays.length === 0" class="time-block-empty">
                {{ t('components.usageTime.empty') }}
              </div>
            </div>
          </div>
        </div>
        <div v-else class="time-block-empty">{{ t('components.usageTime.empty') }}</div>
      </div>

      <!-- 作息热力：最近 7 天 × 24 小时 -->
      <div v-if="heatmapRows.length > 0" class="time-block">
        <span class="time-block-title">{{ t('components.usageTime.heatmapTitle') }}</span>
        <div class="time-heatmap">
          <div class="time-heat-axis">
            <span>0</span>
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
          <div v-for="row in heatmapRows" :key="row.date" class="time-heat-row">
            <span class="time-heat-label">{{ dayLabel(row.date) }}</span>
            <div class="time-heat-cells">
              <div
                v-for="(minutes, hour) in row.hours"
                :key="hour"
                class="time-heat-cell"
                :style="{ opacity: cellOpacity(minutes) }"
                :title="`${row.date} ${String(hour).padStart(2, '0')}:00 · ${formatDuration(minutes)}`"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="time-state">
      <i class="codicon codicon-watch"></i>
      <span>{{ t('components.usageTime.empty') }}</span>
    </div>
  </div>
</template>

<style scoped>
.usage-time-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
}

.time-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.time-title {
  font-size: 12px;
  font-weight: 600;
}

.time-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.time-refresh:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.time-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 范围切换 */
.time-range-bar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.time-range-btn {
  padding: 2px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 10px;
}

.time-range-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.time-range-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.time-range-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.time-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.time-state .codicon {
  font-size: 18px;
}

.time-state.is-error {
  color: var(--vscode-errorForeground);
}

/* 总览卡片 */
.time-totals {
  display: flex;
  gap: 12px;
}

.time-total-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.time-total-value {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.time-total-value.is-active {
  color: var(--vscode-charts-green, var(--vscode-foreground));
}

.time-total-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* 区块 */
.time-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.time-block-title {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.time-block-empty {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding: 4px 0;
}

/* 每日条形图 */
.time-daily {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-day {
  display: flex;
  align-items: center;
  gap: 6px;
}

.time-day-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  width: 32px;
  flex-shrink: 0;
  text-align: right;
}

.time-day-track {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--vscode-panel-border);
  position: relative;
  overflow: hidden;
}

.time-day-bar {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 4px;
  background: var(--vscode-progressBar-background, var(--vscode-button-background));
}

.time-day-value {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  width: 40px;
  flex-shrink: 0;
}

/* 月度条形图 */
.time-monthly {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-month {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-month-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 2px 0;
  border-radius: 4px;
}

.time-month-row:hover {
  background: var(--vscode-list-hoverBackground, transparent);
}

.time-month-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  width: 32px;
  flex-shrink: 0;
  text-align: right;
}

.time-month-value {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  width: 40px;
  flex-shrink: 0;
}

.time-month-days {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.time-month-row .codicon {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.time-month-detail {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 0 4px 38px;
  border-top: 1px dashed var(--vscode-panel-border);
}

/* 作息热力网格 */
.time-heatmap {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.time-heat-axis {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--vscode-descriptionForeground);
  padding-left: 32px;
  padding-right: 0;
}

.time-heat-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.time-heat-label {
  font-size: 9px;
  color: var(--vscode-descriptionForeground);
  width: 32px;
  flex-shrink: 0;
  text-align: right;
}

.time-heat-cells {
  flex: 1;
  display: flex;
  gap: 1px;
}

.time-heat-cell {
  flex: 1;
  height: 10px;
  border-radius: 1px;
  background: var(--vscode-progressBar-background, var(--vscode-button-background));
  opacity: 0.08;
  cursor: default;
}

.time-heat-cell:hover {
  outline: 1px solid var(--vscode-focusBorder, var(--vscode-foreground));
}
</style>
