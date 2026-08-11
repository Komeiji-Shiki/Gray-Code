<script setup lang="ts">
/**
 * UsageSummaryCard - 用量统计（Token 用量摘要卡片，内嵌于设置面板 usage 页签）
 *
 * 从 SettingsPanel.vue 模板拆分（T12 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：stats / range / loading / loadError 由父组件通过 props 注入，
 *   范围切换/刷新/重试/打开完整页均通过 emits 回传，数据加载仍由父组件驱动；
 * - 时间范围选项与 token 格式化属纯展示逻辑，随组件内聚（不触碰任何状态）。
 */
import { computed } from 'vue'
import { t } from '@/i18n'
import type { UsageStatsResult, UsageTimeRange } from '@/types/usage'

defineProps<{
  stats: UsageStatsResult | null
  range: UsageTimeRange
  loading: boolean
  loadError: string
}>()

const emit = defineEmits<{
  (e: 'update:range', range: UsageTimeRange): void
  (e: 'refresh'): void
  (e: 'retry'): void
  (e: 'openFull'): void
}>()

const rangeOptions = computed(() => ([
  { id: 'all' as UsageTimeRange, label: t('components.usage.rangeAll') },
  { id: 'today' as UsageTimeRange, label: t('components.usage.rangeToday') },
  { id: '7d' as UsageTimeRange, label: t('components.usage.range7d') },
  { id: '30d' as UsageTimeRange, label: t('components.usage.range30d') }
]))

/** 格式化 token 数量（1.5K / 1.5M） */
function formatTokens(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return String(count)
}
</script>

<template>
  <!-- Token 用量摘要 -->
  <div class="usage-summary-card">
    <div class="usage-summary-header">
      <span class="usage-summary-title">
        <i class="codicon codicon-graph"></i>
        {{ t('components.usage.title') }}
      </span>
      <button class="usage-summary-refresh" :title="t('components.usage.refresh')" :disabled="loading" @click="emit('refresh')">
        <i class="codicon codicon-refresh"></i>
      </button>
    </div>

    <!-- 时间范围筛选 -->
    <div class="usage-summary-range">
      <button
        v-for="option in rangeOptions"
        :key="option.id"
        :class="['usage-range-btn', { active: range === option.id }]"
        :disabled="loading"
        @click="emit('update:range', option.id)"
      >
        {{ option.label }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="usage-summary-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.usage.loading') }}</span>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="loadError" class="usage-summary-state is-error">
      <i class="codicon codicon-error"></i>
      <span>{{ t('components.usage.loadFailed') }}</span>
      <button class="usage-retry-btn" @click="emit('retry')">{{ t('components.usage.retry') }}</button>
    </div>

    <!-- 空数据 -->
    <div v-else-if="!stats || stats.totals.modelMessages === 0" class="usage-summary-state">
      <i class="codicon codicon-graph"></i>
      <span>{{ t('components.usage.empty') }}</span>
    </div>

    <template v-else>
      <!-- 总览卡片 -->
      <div class="usage-summary-totals">
        <div class="usage-summary-total-item is-main">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.totalTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.totalTokens') }}</span>
        </div>
        <div class="usage-summary-total-item">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.promptTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.promptTokens') }}</span>
        </div>
        <div class="usage-summary-total-item">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.candidatesTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.candidatesTokens') }}</span>
        </div>
        <div class="usage-summary-total-item">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.thoughtsTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.thoughtsTokens') }}</span>
        </div>
        <div v-if="stats.totals.cacheCreationTokens > 0" class="usage-summary-total-item">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.cacheCreationTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.cacheCreationTokens') }}</span>
        </div>
        <div v-if="stats.totals.cacheReadTokens > 0" class="usage-summary-total-item">
          <span class="usage-summary-value">{{ formatTokens(stats.totals.cacheReadTokens) }}</span>
          <span class="usage-summary-label">{{ t('components.usage.cacheReadTokens') }}</span>
        </div>
        <div class="usage-summary-total-item">
          <span class="usage-summary-value">{{ stats.totals.conversations }}</span>
          <span class="usage-summary-label">{{ t('components.usage.conversations') }}</span>
        </div>
        <div class="usage-summary-total-item">
          <span class="usage-summary-value">{{ stats.totals.modelMessages }}</span>
          <span class="usage-summary-label">{{ t('components.usage.modelMessages') }}</span>
        </div>
      </div>

      <!-- 读取失败提示 -->
      <div v-if="stats.totals.skippedConversations > 0" class="usage-skipped-hint">
        <i class="codicon codicon-warning"></i>
        <span>{{ t('components.usage.skippedHint', { count: stats.totals.skippedConversations }) }}</span>
      </div>
    </template>

    <!-- 打开完整用量统计页面 -->
    <div class="usage-summary-footer">
      <button class="usage-open-full-btn" @click="emit('openFull')">
        <i class="codicon codicon-arrow-right"></i>
        {{ t('components.settings.settingsPanel.sections.usage.openFullPage') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 用量统计（设置内嵌摘要） */
.usage-summary-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
}

.usage-summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.usage-summary-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.usage-summary-title .codicon {
  font-size: 14px;
}

.usage-summary-refresh {
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

.usage-summary-refresh:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.usage-summary-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.usage-summary-range {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.usage-range-btn {
  padding: 2px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 10px;
}

.usage-range-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.usage-range-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.usage-range-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.usage-summary-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.usage-summary-state .codicon {
  font-size: 18px;
}

.usage-summary-state.is-error {
  color: var(--vscode-errorForeground);
}

.usage-retry-btn {
  margin-top: 2px;
  padding: 3px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  font-size: 11px;
}

.usage-retry-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.usage-summary-totals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.usage-summary-total-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.usage-summary-value {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.usage-summary-total-item.is-main .usage-summary-value {
  font-size: 18px;
}

.usage-summary-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

.usage-skipped-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-editorWarning-foreground);
}

.usage-skipped-hint .codicon {
  flex-shrink: 0;
}

.usage-summary-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: 10px;
}

.usage-open-full-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-textLink-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.usage-open-full-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.usage-open-full-btn .codicon {
  font-size: 12px;
}

/* Loading 动画（加载态内使用） */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
