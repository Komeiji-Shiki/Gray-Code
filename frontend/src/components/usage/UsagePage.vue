<script setup lang="ts">
/**
 * UsagePage - 用量统计页面
 *
 * 展示从对话历史回溯聚合的 token 用量：
 * - 时间范围筛选（全部 / 今天 / 近 7 天 / 近 30 天）
 * - 总览卡片（总量 / 输入 / 输出 / 思考 / 对话数 / 回复数 / 估算成本）
 * - 按对话 / 按模型 / 按日期 三个维度的列表（CSS 条形图）
 * - 按对话：点击行可直接打开对应对话
 * - 按模型：可配置单价（美元/百万 token）估算成本
 */

import { ref, computed, watch, onMounted } from 'vue'
import { CustomScrollbar } from '../common'
import { useSettingsStore, useChatStore } from '@/stores'
import { sendToExtension } from '@/utils/vscode'
import { t } from '../../i18n'
import type {
  UsageBucket,
  UsageStatsResult,
  UsageTimeRange,
  ModelPricing,
  UsagePricingMap
} from '@/types/usage'

const settingsStore = useSettingsStore()
const chatStore = useChatStore()

const isLoading = ref(false)
const loadError = ref('')
const stats = ref<UsageStatsResult | null>(null)

type UsageTab = 'byConversation' | 'byModel' | 'byDay'
const activeTab = ref<UsageTab>('byConversation')

// ==================== 时间范围 ====================

const activeRange = ref<UsageTimeRange>('all')

const rangeOptions = computed(() => ([
  { id: 'all' as UsageTimeRange, label: t('components.usage.rangeAll') },
  { id: 'today' as UsageTimeRange, label: t('components.usage.rangeToday') },
  { id: '7d' as UsageTimeRange, label: t('components.usage.range7d') },
  { id: '30d' as UsageTimeRange, label: t('components.usage.range30d') }
]))

/** 快捷范围 → 起始时间（本地 00:00 对齐；'all' 不限制） */
function rangeToStartTime(range: UsageTimeRange): number | undefined {
  if (range === 'all') return undefined
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  if (range === 'today') return startOfToday.getTime()
  const days = range === '7d' ? 6 : 29
  return startOfToday.getTime() - days * 24 * 60 * 60 * 1000
}

// ==================== 数据加载 ====================

async function loadStats() {
  isLoading.value = true
  loadError.value = ''
  try {
    const startTime = rangeToStartTime(activeRange.value)
    const query = startTime !== undefined ? { startTime } : {}
    stats.value = await sendToExtension<UsageStatsResult>('usage.getStats', query)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

// 切换时间范围时重新聚合
watch(activeRange, loadStats)

// 页面保活（v-show 切换）后，重新进入时自动刷新
watch(() => settingsStore.currentView, (view) => {
  if (view === 'usage') loadStats()
})

onMounted(() => {
  loadStats()
  loadPricing()
})

// ==================== 模型单价与成本估算 ====================

const pricing = ref<UsagePricingMap>({})
const editingModel = ref('')
const editInput = ref('')
const editOutput = ref('')

async function loadPricing() {
  try {
    const response = await sendToExtension<any>('getSettings', {})
    const saved = response?.settings?.ui?.usagePricing
    pricing.value = saved && typeof saved === 'object' ? saved : {}
  } catch {
    pricing.value = {}
  }
}

/** 取某模型的有效单价（两项均未配置时返回 null） */
function pricingOf(modelVersion: string): ModelPricing | null {
  const entry = pricing.value[modelVersion]
  if (!entry) return null
  const input = Number(entry.input) || 0
  const output = Number(entry.output) || 0
  if (input <= 0 && output <= 0) return null
  return { input, output }
}

/** 估算成本：输入按 input 价，输出与思考按 output 价（美元/百万 token） */
function costOfBucket(bucket: UsageBucket, price: ModelPricing): number {
  return (
    (bucket.promptTokens / 1e6) * price.input +
    ((bucket.candidatesTokens + bucket.thoughtsTokens) / 1e6) * price.output
  )
}

/** 全部已配置单价模型的总估算成本（无任何配置时为 null） */
const totalCost = computed<number | null>(() => {
  const data = stats.value
  if (!data) return null
  let total = 0
  let priced = false
  for (const item of data.byModel) {
    const price = pricingOf(item.modelVersion)
    if (!price) continue
    total += costOfBucket(item, price)
    priced = true
  }
  return priced ? total : null
})

function formatCost(cost: number): string {
  return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)}`
}

function startEditPricing(modelVersion: string) {
  editingModel.value = modelVersion
  const entry = pricing.value[modelVersion]
  editInput.value = entry?.input ? String(entry.input) : ''
  editOutput.value = entry?.output ? String(entry.output) : ''
}

function cancelEditPricing() {
  editingModel.value = ''
}

async function savePricing() {
  const modelVersion = editingModel.value
  if (!modelVersion) return
  const input = Math.max(0, Number(editInput.value) || 0)
  const output = Math.max(0, Number(editOutput.value) || 0)
  pricing.value = { ...pricing.value, [modelVersion]: { input, output } }
  editingModel.value = ''
  try {
    await sendToExtension('updateUISettings', {
      ui: { usagePricing: { [modelVersion]: { input, output } } }
    })
  } catch (error) {
    console.error('Failed to save usage pricing:', error)
  }
}

// ==================== 对话跳转 ====================

async function openConversation(conversationId: string) {
  try {
    await chatStore.switchConversation(conversationId)
  } catch (error) {
    console.error('Failed to open conversation from usage page:', error)
  } finally {
    settingsStore.showChat()
  }
}

// ==================== 展示数据 ====================

/** 格式化 token 数量（1.5K / 1.5M） */
function formatTokens(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return String(count)
}

/** 当前 tab 的列表行（统一为 label + bucket 结构） */
interface UsageRow extends UsageBucket {
  key: string
  label: string
  conversationId?: string
  modelVersion?: string
  cost?: number | null
}

const rows = computed<UsageRow[]>(() => {
  const data = stats.value
  if (!data) return []
  if (activeTab.value === 'byConversation') {
    return data.byConversation.map(item => ({
      ...item,
      key: item.conversationId,
      label: item.title
    }))
  }
  if (activeTab.value === 'byModel') {
    return data.byModel.map(item => {
      const price = pricingOf(item.modelVersion)
      return {
        ...item,
        key: item.modelVersion,
        label: item.modelVersion === 'unknown' ? t('components.usage.unknownModel') : item.modelVersion,
        cost: price ? costOfBucket(item, price) : null
      }
    })
  }
  return data.byDay.map(item => ({ ...item, key: item.date, label: item.date }))
})

/** 条形宽度基准：当前列表中最大的 totalTokens */
const maxRowTotal = computed(() => rows.value.reduce((max, row) => Math.max(max, row.totalTokens), 0))

function barWidth(row: UsageRow): string {
  if (maxRowTotal.value <= 0) return '0%'
  return `${Math.max(2, Math.round((row.totalTokens / maxRowTotal.value) * 100))}%`
}

function handleRowClick(row: UsageRow) {
  if (activeTab.value === 'byConversation' && row.conversationId) {
    openConversation(row.conversationId)
  }
}

function formatGeneratedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

const tabs = computed(() => ([
  { id: 'byConversation' as UsageTab, label: t('components.usage.byConversation') },
  { id: 'byModel' as UsageTab, label: t('components.usage.byModel') },
  { id: 'byDay' as UsageTab, label: t('components.usage.byDay') }
]))
</script>

<template>
  <div class="usage-page">
    <!-- 页面标题栏 -->
    <div class="page-header">
      <h3>{{ t('components.usage.title') }}</h3>
      <div class="header-actions">
        <button class="header-btn" :title="t('components.usage.refresh')" :disabled="isLoading" @click="loadStats">
          <i class="codicon codicon-refresh"></i>
        </button>
        <button class="header-btn" :title="t('components.usage.backToChat')" @click="settingsStore.showChat">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
    </div>

    <!-- 时间范围筛选（常驻） -->
    <div class="range-bar">
      <button
        v-for="option in rangeOptions"
        :key="option.id"
        :class="['range-btn', { active: activeRange === option.id }]"
        :disabled="isLoading"
        @click="activeRange = option.id"
      >
        {{ option.label }}
      </button>
    </div>

    <CustomScrollbar class="page-content">
      <!-- 加载中 -->
      <div v-if="isLoading" class="state-hint">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.usage.loading') }}</span>
      </div>

      <!-- 加载失败 -->
      <div v-else-if="loadError" class="state-hint is-error">
        <i class="codicon codicon-error"></i>
        <span>{{ t('components.usage.loadFailed') }}</span>
        <button class="retry-btn" @click="loadStats">{{ t('components.usage.retry') }}</button>
      </div>

      <!-- 空数据 -->
      <div v-else-if="!stats || stats.totals.modelMessages === 0" class="state-hint">
        <i class="codicon codicon-graph"></i>
        <span>{{ t('components.usage.empty') }}</span>
      </div>

      <template v-else>
        <!-- 总览卡片 -->
        <div class="totals-card">
          <div class="total-main">
            <span class="total-value">{{ formatTokens(stats.totals.totalTokens) }}</span>
            <span class="total-label">{{ t('components.usage.totalTokens') }}</span>
          </div>
          <div class="total-breakdown">
            <div class="breakdown-item">
              <span class="breakdown-value">{{ formatTokens(stats.totals.promptTokens) }}</span>
              <span class="breakdown-label">{{ t('components.usage.promptTokens') }}</span>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-value">{{ formatTokens(stats.totals.candidatesTokens) }}</span>
              <span class="breakdown-label">{{ t('components.usage.candidatesTokens') }}</span>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-value">{{ formatTokens(stats.totals.thoughtsTokens) }}</span>
              <span class="breakdown-label">{{ t('components.usage.thoughtsTokens') }}</span>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-value">{{ stats.totals.conversations }}</span>
              <span class="breakdown-label">{{ t('components.usage.conversations') }}</span>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-value">{{ stats.totals.modelMessages }}</span>
              <span class="breakdown-label">{{ t('components.usage.modelMessages') }}</span>
            </div>
            <div v-if="totalCost !== null" class="breakdown-item">
              <span class="breakdown-value">{{ formatCost(totalCost) }}</span>
              <span class="breakdown-label">{{ t('components.usage.estimatedCost') }}</span>
            </div>
          </div>
        </div>

        <!-- 读取失败提示 -->
        <div v-if="stats.totals.skippedConversations > 0" class="skipped-hint">
          <i class="codicon codicon-warning"></i>
          {{ t('components.usage.skippedHint', { count: stats.totals.skippedConversations }) }}
        </div>

        <!-- 维度切换 -->
        <div class="tab-bar">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            :class="['tab-btn', { active: activeTab === tab.id }]"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <!-- 维度列表 -->
        <div class="usage-list">
          <div
            v-for="row in rows"
            :key="row.key"
            :class="['usage-row', { clickable: activeTab === 'byConversation' }]"
            :title="activeTab === 'byConversation' ? t('components.usage.openConversation') : row.label"
            @click="handleRowClick(row)"
          >
            <div class="row-header">
              <span class="row-label">{{ row.label }}</span>
              <div class="row-side">
                <span v-if="typeof row.cost === 'number'" class="row-cost">≈ {{ formatCost(row.cost) }}</span>
                <button
                  v-if="activeTab === 'byModel'"
                  class="row-edit-btn"
                  :title="t('components.usage.editPricing')"
                  @click.stop="startEditPricing(row.modelVersion!)"
                >
                  <i class="codicon codicon-tag"></i>
                </button>
                <span class="row-total">{{ formatTokens(row.totalTokens) }}</span>
              </div>
            </div>
            <div class="row-bar-track">
              <div class="row-bar" :style="{ width: barWidth(row) }"></div>
            </div>
            <div class="row-detail">
              <span>{{ t('components.usage.promptTokens') }} {{ formatTokens(row.promptTokens) }}</span>
              <span>{{ t('components.usage.candidatesTokens') }} {{ formatTokens(row.candidatesTokens) }}</span>
              <span v-if="row.thoughtsTokens > 0">{{ t('components.usage.thoughtsTokens') }} {{ formatTokens(row.thoughtsTokens) }}</span>
              <span>{{ t('components.usage.modelMessages') }} {{ row.modelMessages }}</span>
            </div>

            <!-- 单价编辑区（仅按模型维度） -->
            <div
              v-if="activeTab === 'byModel' && editingModel === row.modelVersion"
              class="pricing-editor"
              @click.stop
            >
              <div class="pricing-title">{{ t('components.usage.editPricing') }}</div>
              <div class="pricing-fields">
                <label class="pricing-field">
                  <span>{{ t('components.usage.inputPrice') }}</span>
                  <input v-model="editInput" type="number" min="0" step="0.01" />
                </label>
                <label class="pricing-field">
                  <span>{{ t('components.usage.outputPrice') }}</span>
                  <input v-model="editOutput" type="number" min="0" step="0.01" />
                </label>
              </div>
              <div class="pricing-actions">
                <button class="pricing-save" @click="savePricing">{{ t('components.usage.save') }}</button>
                <button class="pricing-cancel" @click="cancelEditPricing">{{ t('components.usage.cancel') }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 统计时间 -->
        <div class="generated-at">
          {{ t('components.usage.generatedAt') }}: {{ formatGeneratedAt(stats.generatedAt) }}
        </div>
      </template>
    </CustomScrollbar>
  </div>
</template>

<style scoped>
.usage-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-sideBar-background);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.page-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.header-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.header-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 时间范围筛选 */
.range-bar {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.range-btn {
  padding: 3px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 11px;
}

.range-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.range-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.range-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.page-content {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
}

.state-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.state-hint .codicon {
  font-size: 24px;
}

.state-hint.is-error {
  color: var(--vscode-errorForeground);
}

.retry-btn {
  margin-top: 4px;
  padding: 4px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  font-size: 12px;
}

.retry-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* 总览卡片 */
.totals-card {
  padding: 16px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
  margin-bottom: 12px;
}

.total-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}

.total-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.total-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.total-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.breakdown-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.breakdown-value {
  font-size: 14px;
  font-weight: 500;
}

.breakdown-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 跳过提示 */
.skipped-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 12px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, transparent);
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  color: var(--vscode-foreground);
  font-size: 11px;
}

/* 维度切换 */
.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}

.tab-btn {
  padding: 4px 12px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 12px;
}

.tab-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.tab-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

/* 维度列表 */
.usage-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.usage-row {
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.usage-row.clickable {
  cursor: pointer;
}

.usage-row.clickable:hover {
  background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
}

.row-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.row-label {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.row-cost {
  font-size: 11px;
  color: var(--vscode-charts-green, var(--vscode-descriptionForeground));
}

.row-edit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.row-edit-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.row-edit-btn .codicon {
  font-size: 12px;
}

.row-total {
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.row-bar-track {
  height: 4px;
  border-radius: 2px;
  background: var(--vscode-panel-border);
  position: relative;
  margin-bottom: 6px;
}

.row-bar {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 2px;
  background: var(--vscode-progressBar-background, var(--vscode-button-background));
}

.row-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 单价编辑区 */
.pricing-editor {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, transparent);
  cursor: default;
}

.pricing-title {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 6px;
}

.pricing-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.pricing-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 100px;
}

.pricing-field span {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.pricing-field input {
  padding: 3px 6px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 12px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.pricing-field input:focus {
  border-color: var(--vscode-focusBorder);
}

.pricing-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.pricing-save,
.pricing-cancel {
  padding: 3px 12px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  border: 1px solid var(--vscode-button-border, transparent);
}

.pricing-save {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.pricing-save:hover {
  background: var(--vscode-button-hoverBackground);
}

.pricing-cancel {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.pricing-cancel:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.generated-at {
  margin-top: 12px;
  padding-bottom: 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-align: right;
}
</style>
