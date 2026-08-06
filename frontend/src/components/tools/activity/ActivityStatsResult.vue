<script setup lang="ts">
/**
 * get_activity_stats 工具结果展示组件
 *
 * 把活动统计的原始 JSON 渲染为可视化卡片：
 * - 总览：今日已用 / 当前连续工作 / 范围内合计
 * - 每日使用时长条形图（超过 31 天时截断并附提示）
 * - 每月使用时长条形图（仅长范围概览时出现）
 * - 最近 7 天 × 24 小时作息热力图
 *
 * 数据来自后端 get_activity_stats 工具（时间已转为本地 HH:mm / YYYY-MM-DD 字符串）。
 */
import { computed } from 'vue'
import { t } from '../../../i18n'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

interface DayStats {
  date: string
  totalMinutes: number
  sessionCount: number
  firstActiveAt: string | null
  lastActiveAt: string | null
}

interface MonthStats {
  month: string
  totalMinutes: number
  activeDays: number
  sessionCount: number
}

interface HeatRow {
  date: string
  hours: number[]
}

interface ActivityStatsData {
  generatedAt: string
  today: DayStats | null
  currentSession: { active: boolean; startedAt: string | null; minutes: number }
  daily: DayStats[]
  monthly: MonthStats[]
  hourlyHeatmap: HeatRow[]
}

// ─── 状态 ───

const isSuccess = computed(() => props.result?.success === true)
const errorMessage = computed(() => (props.result?.error as string | undefined) || props.error)
const data = computed(() => props.result?.data as ActivityStatsData | undefined)

// ─── 总览 ───

const todayMinutes = computed(() => data.value?.today?.totalMinutes ?? 0)
const currentSessionActive = computed(() => data.value?.currentSession?.active ?? false)
const currentSessionMinutes = computed(() => data.value?.currentSession?.minutes ?? 0)
const rangeTotalMinutes = computed(() =>
  (data.value?.daily ?? []).reduce((sum, d) => sum + d.totalMinutes, 0)
)

/** 今日卡片 tooltip：日期 · 会话数 · 活跃区间 */
const todayDetail = computed(() => {
  const today = data.value?.today
  if (!today) return ''
  const parts = [today.date]
  if (today.sessionCount > 0) parts.push(`${today.sessionCount} sessions`)
  if (today.firstActiveAt && today.lastActiveAt) {
    parts.push(`${today.firstActiveAt} - ${today.lastActiveAt}`)
  }
  return parts.join(' · ')
})

// ─── 每日条形图（最多 31 行） ───

const MAX_DAILY_ROWS = 31

const dailyList = computed(() => {
  const list = data.value?.daily ?? []
  return [...list].reverse().slice(0, MAX_DAILY_ROWS)
})

const dailyTruncated = computed(() => (data.value?.daily.length ?? 0) > MAX_DAILY_ROWS)

const maxDailyMinutes = computed(() =>
  Math.max(1, ...dailyList.value.map((d) => d.totalMinutes))
)

// ─── 月度条形图（长范围概览） ───

const monthlyList = computed(() => data.value?.monthly ?? [])

/** 只有每日列表被截断（长范围）时才显示月度概览 */
const showMonthly = computed(() => monthlyList.value.length > 0 && dailyTruncated.value)

const maxMonthlyMinutes = computed(() =>
  Math.max(1, ...monthlyList.value.map((m) => m.totalMinutes))
)

// ─── 热力图（最近 7 天） ───

const heatmapRows = computed(() => (data.value?.hourlyHeatmap ?? []).slice(-7))

const maxHourMinutes = computed(() =>
  Math.max(1, ...heatmapRows.value.flatMap((row) => row.hours))
)

// ─── 格式化 ───

function formatDuration(minutes: number): string {
  if (minutes <= 0) return `0${t('components.usageTime.minutes')}`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}${t('components.usageTime.minutes')}`
  if (m === 0) return `${h}${t('components.usageTime.hours')}`
  return t('components.usageTime.durationHM', { hours: h, minutes: m })
}

function formatShort(minutes: number): string {
  if (minutes <= 0) return '0'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}${t('components.usageTime.shortMinute')}`
  if (m === 0) return `${h}${t('components.usageTime.shortHour')}`
  return `${h}${t('components.usageTime.shortHour')} ${m}${t('components.usageTime.shortMinute')}`
}

function dayLabel(date: string): string {
  const [, m, d] = date.split('-')
  return `${m}-${d}`
}

function monthLabel(month: string): string {
  return month.slice(2)
}

function barWidth(minutes: number, maxMinutes: number): string {
  return `${Math.max(2, Math.round((minutes / Math.max(1, maxMinutes)) * 100))}%`
}

function cellOpacity(minutes: number): number {
  if (minutes <= 0) return 0.08
  return 0.25 + 0.75 * (minutes / maxHourMinutes.value)
}

function hourTitle(row: HeatRow, hour: number): string {
  const minutes = row.hours[hour] ?? 0
  return `${row.date} ${String(hour).padStart(2, '0')}:00 · ${formatDuration(minutes)}`
}
</script>

<template>
  <div class="activity-stats">
    <!-- 等待结果 -->
    <div v-if="!result" class="as-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.usageTime.loading') }}</span>
    </div>

    <!-- 失败 -->
    <div v-else-if="!isSuccess" class="as-state is-error">
      <i class="codicon codicon-error"></i>
      <span>{{ errorMessage || t('components.usageTime.loadFailed') }}</span>
    </div>

    <!-- 成功 -->
    <template v-else-if="data">
      <div class="as-header">
        <span class="as-title">
          <i class="codicon codicon-graph-line"></i>
          Activity Stats
        </span>
        <span v-if="data.generatedAt" class="as-generated">{{ data.generatedAt }}</span>
      </div>

      <!-- 总览 -->
      <div class="as-totals">
        <div class="as-total-item" :title="todayDetail || undefined">
          <span class="as-total-value">{{ formatDuration(todayMinutes) }}</span>
          <span class="as-total-label">{{ t('components.usageTime.today') }}</span>
        </div>
        <div class="as-total-item">
          <span class="as-total-value" :class="{ 'is-active': currentSessionActive }">
            {{ currentSessionActive ? formatDuration(currentSessionMinutes) : '—' }}
          </span>
          <span class="as-total-label">{{ t('components.usageTime.currentSession') }}</span>
        </div>
        <div class="as-total-item">
          <span class="as-total-value">{{ formatDuration(rangeTotalMinutes) }}</span>
          <span class="as-total-label">{{ t('components.usageTime.totalInRange') }}</span>
        </div>
      </div>

      <!-- 每日条形图 -->
      <div v-if="dailyList.length > 0" class="as-block">
        <span class="as-block-title">
          {{ t('components.usageTime.dailyTitle') }}
          <span v-if="dailyTruncated" class="as-block-note">
            {{ t('components.usageTime.onlyShowLatest', { days: MAX_DAILY_ROWS }) }}
          </span>
        </span>
        <div class="as-daily">
          <div v-for="day in dailyList" :key="day.date" class="as-day">
            <span class="as-day-label">{{ dayLabel(day.date) }}</span>
            <div class="as-day-track">
              <div
                class="as-day-bar"
                :style="{ width: barWidth(day.totalMinutes, maxDailyMinutes) }"
                :title="`${day.date}: ${formatDuration(day.totalMinutes)}`"
              ></div>
            </div>
            <span class="as-day-value">{{ formatShort(day.totalMinutes) }}</span>
          </div>
        </div>
      </div>

      <!-- 月度条形图（长范围概览） -->
      <div v-if="showMonthly" class="as-block">
        <span class="as-block-title">{{ t('components.usageTime.monthlyTitleShort') }}</span>
        <div class="as-monthly">
          <div v-for="item in monthlyList" :key="item.month" class="as-month">
            <span class="as-month-label">{{ monthLabel(item.month) }}</span>
            <div class="as-day-track">
              <div
                class="as-day-bar"
                :style="{ width: barWidth(item.totalMinutes, maxMonthlyMinutes) }"
                :title="`${item.month}: ${formatDuration(item.totalMinutes)} · ${t('components.usageTime.monthActiveDays', { days: item.activeDays })}`"
              ></div>
            </div>
            <span class="as-month-value">
              {{ formatShort(item.totalMinutes) }}
              <span class="as-month-days">{{ t('components.usageTime.monthActiveDays', { days: item.activeDays }) }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 作息热力图 -->
      <div v-if="heatmapRows.length > 0" class="as-block">
        <span class="as-block-title">{{ t('components.usageTime.heatmapTitle') }}</span>
        <div class="as-heatmap">
          <div class="as-heat-axis">
            <span>0</span>
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
          <div v-for="row in heatmapRows" :key="row.date" class="as-heat-row">
            <span class="as-heat-label">{{ dayLabel(row.date) }}</span>
            <div class="as-heat-cells">
              <div
                v-for="(minutes, hour) in row.hours"
                :key="hour"
                class="as-heat-cell"
                :style="{ opacity: cellOpacity(minutes) }"
                :title="hourTitle(row, hour)"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.activity-stats {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
  font-size: 11px;
}

/* 状态 */
.as-state {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
  color: var(--vscode-descriptionForeground);
}

.as-state.is-error {
  color: var(--vscode-errorForeground);
}

.as-state .codicon {
  font-size: 14px;
}

/* 头部 */
.as-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.as-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.as-title .codicon {
  color: var(--vscode-charts-blue, var(--vscode-foreground));
}

.as-generated {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family), monospace;
}

/* 总览卡片 */
.as-totals {
  display: flex;
  gap: 12px;
  padding: 8px 10px;
  background: var(--vscode-editor-background);
  border-radius: 4px;
  border-left: 3px solid var(--vscode-charts-blue, var(--vscode-foreground));
}

.as-total-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.as-total-value {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--vscode-foreground);
}

.as-total-value.is-active {
  color: var(--vscode-charts-green, var(--vscode-foreground));
}

.as-total-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* 区块 */
.as-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.as-block-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
}

.as-block-note {
  font-weight: 400;
  opacity: 0.8;
}

/* 条形图 */
.as-daily,
.as-monthly {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.as-day,
.as-month {
  display: flex;
  align-items: center;
  gap: 8px;
}

.as-day-label,
.as-month-label {
  flex-shrink: 0;
  width: 34px;
  text-align: right;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family), monospace;
}

.as-day-track {
  flex: 1;
  height: 8px;
  background: var(--vscode-editor-background);
  border-radius: 2px;
  overflow: hidden;
}

.as-day-bar {
  height: 100%;
  min-width: 2px;
  background: var(--vscode-charts-blue, var(--vscode-foreground));
  border-radius: 2px;
  opacity: 0.85;
}

.as-day-value {
  flex-shrink: 0;
  width: 48px;
  font-size: 10px;
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family), monospace;
  text-align: right;
}

.as-month-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family), monospace;
}

.as-month-days {
  color: var(--vscode-descriptionForeground);
}

/* 热力图 */
.as-heatmap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.as-heat-axis {
  display: flex;
  justify-content: space-between;
  padding-left: 42px;
  font-size: 9px;
  color: var(--vscode-descriptionForeground);
}

.as-heat-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.as-heat-label {
  flex-shrink: 0;
  width: 34px;
  text-align: right;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family), monospace;
}

.as-heat-cells {
  display: flex;
  flex: 1;
  gap: 2px;
}

.as-heat-cell {
  flex: 1;
  aspect-ratio: 1;
  min-width: 4px;
  background: var(--vscode-charts-blue, var(--vscode-foreground));
  border-radius: 1px;
}
</style>
