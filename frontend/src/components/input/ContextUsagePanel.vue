<script setup lang="ts">
/**
 * ContextUsagePanel - 上下文占用面板
 *
 * 点击 InputArea 的 Token 环打开：占用条和分类行一眼看清上下文花在哪，
 * 分类可展开到单个工具或提示词段落；总结与消息范围收在折叠区，展开时才读取。
 * 薄展示层，RPC 与整形委托 contextStats.ts；只读，不触发总结。
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import { IconButton } from '../common'
import { formatNumber, formatTime } from '@/utils/format'
import {
  buildContextUsageRows,
  extractRpcErrorMessage,
  fetchContextBreakdown,
  fetchContextDescribe,
  fetchSummaryDetail,
  isMissingHandlerError,
  isPreciseSource,
  toSummaryTokenView,
  type ContextBreakdown,
  type ContextBreakdownItem,
  type ContextBreakdownRequest,
  type ContextDescribeResult,
  type ContextSummaryDetail,
  type ContextUsageRowId
} from './contextStats'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  request: ContextBreakdownRequest
  /** 上次请求的接口合计，也是新回合完成后刷新分类的信号。 */
  usedTokens: number
  /** 打开面板的控件：点击它由控件自己切换，不算点击面板外部。 */
  anchor?: HTMLElement | null
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const panel = ref<HTMLElement | null>(null)
const maxHeight = ref<string>()
const loading = ref(false)
const error = ref('')
const breakdown = ref<ContextBreakdown | null>(null)
const expandedRow = ref<ContextUsageRowId | null>(null)

const detailsOpen = ref(false)
const describeLoading = ref(false)
const describeError = ref('')
const describeDesktopOnly = ref(false)
const describe = ref<ContextDescribeResult | null>(null)

const detailLoading = ref(false)
const detailError = ref('')
const detail = ref<ContextSummaryDetail | null>(null)

let breakdownEpoch = 0
let describeEpoch = 0
let detailEpoch = 0
let shownConversationId: string | null | undefined

const rows = computed(() => breakdown.value ? buildContextUsageRows(breakdown.value) : [])
const barRows = computed(() => rows.value.filter(row => row.id !== 'freeSpace' && !row.uncounted))
const usedPercent = computed(() => breakdown.value ? breakdown.value.totalTokens / breakdown.value.maxContextTokens * 100 : 0)
const usageLevel = computed(() => usedPercent.value >= 90 ? 'danger' : usedPercent.value >= 75 ? 'warning' : '')

const sourceLabel = computed(() => {
  const source = describe.value?.tokens.source ?? 'none'
  if (isPreciseSource(source)) return t('components.input.contextDetail.sourcePrecise')
  if (source === 'summary-estimate') return t('components.input.contextDetail.sourceEstimate')
  return t('components.input.contextDetail.sourceNone')
})

const policyLabel = computed(() => {
  const enabled = describe.value?.range.policyEnabled
  if (enabled === true) return t('components.input.contextDetail.enabled')
  if (enabled === false) return t('components.input.contextDetail.disabled')
  return t('components.input.contextDetail.unknown')
})

function close() {
  emit('update:modelValue', false)
}

function rowLabel(id: ContextUsageRowId): string {
  return t(`components.input.contextDetail.categories.${id}`)
}

function itemLabel(item: ContextBreakdownItem): string {
  return item.label ?? t(`components.input.contextDetail.items.${item.id}`)
}

/** 消息明细里的工具名指它的结果，和“内置工具”分类里的定义是两回事。 */
function itemDetail(item: ContextBreakdownItem): string | undefined {
  return item.id.startsWith('tool:') ? t('components.input.contextDetail.items.toolResult') : item.detail
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatIndex(value: number | undefined): string {
  return typeof value === 'number' && value >= 0 ? `#${value}` : '—'
}

function toggleRow(id: ContextUsageRowId) {
  expandedRow.value = expandedRow.value === id ? null : id
}

function backToList() {
  detailEpoch++
  detailLoading.value = false
  detail.value = null
  detailError.value = ''
}

async function loadBreakdown() {
  const epoch = ++breakdownEpoch
  error.value = ''
  if (!props.request.configId) {
    breakdown.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await fetchContextBreakdown(props.request)
    if (epoch === breakdownEpoch) breakdown.value = result
  } catch (failure) {
    if (epoch !== breakdownEpoch) return
    breakdown.value = null
    error.value = extractRpcErrorMessage(failure)
  } finally {
    if (epoch === breakdownEpoch) loading.value = false
  }
}

async function loadDescribe() {
  const epoch = ++describeEpoch
  const conversationId = props.request.conversationId
  backToList()
  describeError.value = ''
  describeDesktopOnly.value = false
  if (!conversationId) {
    describe.value = null
    describeLoading.value = false
    return
  }
  describeLoading.value = true
  try {
    const result = await fetchContextDescribe(conversationId, {
      ...(props.request.configId ? { providerId: props.request.configId } : {}),
      ...(props.request.modelOverride ? { modelOverride: props.request.modelOverride } : {})
    })
    if (epoch === describeEpoch) describe.value = result
  } catch (failure) {
    if (epoch !== describeEpoch) return
    describe.value = null
    describeError.value = extractRpcErrorMessage(failure)
    describeDesktopOnly.value = isMissingHandlerError(failure)
  } finally {
    if (epoch === describeEpoch) describeLoading.value = false
  }
}

async function openDetail(messageId: string | undefined) {
  const conversationId = props.request.conversationId
  if (!conversationId || !messageId) return
  const epoch = ++detailEpoch
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await fetchSummaryDetail(conversationId, messageId)
    if (epoch === detailEpoch) detail.value = result
  } catch (failure) {
    if (epoch !== detailEpoch) return
    detail.value = null
    detailError.value = extractRpcErrorMessage(failure)
  } finally {
    if (epoch === detailEpoch) detailLoading.value = false
  }
}

function handleDetailsToggle(event: Event) {
  detailsOpen.value = (event.target as HTMLDetailsElement).open
  if (detailsOpen.value && !describe.value) void loadDescribe()
}

function refresh() {
  if (props.request.conversationId !== shownConversationId) {
    shownConversationId = props.request.conversationId
    breakdown.value = null
    describe.value = null
    expandedRow.value = null
  }
  void loadBreakdown()
  if (detailsOpen.value) void loadDescribe()
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !props.anchor?.contains(target)) close()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  close()
  props.anchor?.focus()
}

/** 面板向上展开，可用高度是输入区上方的空间，它随输入内容和窗口变化，纯 CSS 算不出来。 */
function fitAboveInputArea() {
  const top = panel.value?.offsetParent?.getBoundingClientRect().top
  if (top !== undefined) maxHeight.value = `${Math.max(160, top - 12)}px`
}

function stopListening() {
  document.removeEventListener('pointerdown', handlePointerDown)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', fitAboveInputArea)
}

watch(() => [props.modelValue, props.request, props.usedTokens] as const, ([visible]) => {
  stopListening()
  if (visible) {
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeydown)
    window.addEventListener('resize', fitAboveInputArea)
    refresh()
    return
  }
  breakdownEpoch++
  describeEpoch++
  loading.value = false
  describeLoading.value = false
  backToList()
}, { immediate: true })

watch(panel, element => { if (element) fitAboveInputArea() })

onBeforeUnmount(() => {
  breakdownEpoch++
  describeEpoch++
  detailEpoch++
  stopListening()
})
</script>

<template>
  <section
    v-if="modelValue"
    ref="panel"
    class="context-usage"
    role="dialog"
    :style="{ maxHeight }"
    :aria-label="t('components.input.contextDetail.title')"
  >
    <header class="usage-head">
      <span class="usage-title">{{ t('components.input.contextDetail.title') }}</span>
      <span v-if="breakdown" class="usage-model" :title="breakdown.model">{{ breakdown.model }}</span>
      <IconButton
        icon="codicon-refresh"
        size="small"
        class="usage-refresh"
        :tooltip="t('components.input.contextDetail.refresh')"
        :aria-label="t('components.input.contextDetail.refresh')"
        :loading="loading"
        :disabled="loading || !request.configId"
        @click="refresh"
      />
    </header>

    <p v-if="!request.configId" class="usage-state">{{ t('components.input.contextDetail.noModel') }}</p>
    <p v-else-if="error" class="usage-error" role="alert">{{ error }}</p>
    <p v-else-if="!breakdown" class="usage-state">{{ t('components.input.contextDetail.loading') }}</p>

    <template v-else>
      <div class="usage-total">
        <span class="usage-total-percent" :class="usageLevel">
          {{ t('components.input.contextDetail.usedPercent', { percent: usedPercent.toFixed(1) }) }}
        </span>
        <span class="usage-total-tokens">{{ formatNumber(breakdown.totalTokens) }} / {{ formatNumber(breakdown.maxContextTokens) }}</span>
      </div>

      <div class="usage-bar" role="img" :aria-label="t('components.input.contextDetail.usedPercent', { percent: usedPercent.toFixed(1) })">
        <span
          v-for="row in barRows"
          :key="row.id"
          class="usage-segment"
          :class="[`usage-color-${row.id}`, { expandable: row.items.length }]"
          :style="{ width: `${row.percent}%` }"
          :title="`${rowLabel(row.id)} ${formatNumber(row.tokens)} (${formatPercent(row.percent)})`"
          @click="row.items.length && toggleRow(row.id)"
        ></span>
      </div>

      <p v-for="notice in breakdown.notices" :key="notice" class="usage-notice">{{ notice }}</p>

      <ul class="usage-rows">
        <li v-for="row in rows" :key="row.id" :class="`usage-color-${row.id}`">
          <component
            :is="row.items.length ? 'button' : 'div'"
            class="usage-row"
            :class="{ expandable: row.items.length, uncounted: row.uncounted }"
            v-bind="row.items.length ? { type: 'button', 'aria-expanded': expandedRow === row.id } : {}"
            @click="row.items.length && toggleRow(row.id)"
          >
            <span class="usage-swatch" aria-hidden="true"></span>
            <span class="usage-row-label">{{ rowLabel(row.id) }}</span>
            <span class="usage-row-tokens">{{ formatNumber(row.tokens) }}</span>
            <span class="usage-row-percent">{{ row.uncounted ? '—' : formatPercent(row.percent) }}</span>
            <i
              class="codicon usage-chevron"
              :class="{ 'codicon-chevron-right': row.items.length, open: expandedRow === row.id }"
              aria-hidden="true"
            ></i>
          </component>
          <ul v-if="expandedRow === row.id" class="usage-items">
            <li v-for="item in row.items" :key="item.id" class="usage-item">
              <span class="usage-item-label" :title="itemLabel(item)">{{ itemLabel(item) }}</span>
              <span v-if="itemDetail(item)" class="usage-item-detail" :title="itemDetail(item)">{{ itemDetail(item) }}</span>
              <span class="usage-item-tokens">{{ formatNumber(item.tokens) }}</span>
            </li>
          </ul>
        </li>
      </ul>

      <p class="usage-note">
        {{ t('components.input.contextDetail.estimateNote', { encoding: breakdown.tokenizer }) }}
        <template v-if="usedTokens > 0">
          <br>{{ t('components.input.contextDetail.lastRequest', { tokens: formatNumber(usedTokens) }) }}
        </template>
      </p>

      <details v-if="request.conversationId" class="usage-details" :open="detailsOpen" @toggle="handleDetailsToggle">
        <summary>{{ t('components.input.contextDetail.detailsTitle') }}</summary>

        <p v-if="describeLoading && !describe" class="usage-state">{{ t('components.input.contextDetail.loading') }}</p>
        <p v-else-if="describeError" class="usage-error" role="alert">
          <template v-if="describeDesktopOnly">{{ t('components.input.contextDetail.desktopOnly') }}：</template>{{ describeError }}
        </p>

        <template v-else-if="describe && !detail">
          <dl class="usage-facts">
            <dt>{{ t('components.input.contextDetail.source') }}</dt>
            <dd>{{ sourceLabel }}</dd>
            <dt>{{ t('components.input.contextDetail.preciseTokens') }}</dt>
            <dd>
              {{
                describe.tokens.preciseAvailable && describe.tokens.preciseTokens !== undefined
                  ? formatNumber(describe.tokens.preciseTokens)
                  : t('components.input.contextDetail.preciseUnavailable')
              }}
            </dd>
            <dt>{{ t('components.input.contextDetail.total') }}</dt>
            <dd>{{ describe.range.total }}</dd>
            <dt>{{ t('components.input.contextDetail.visible') }}</dt>
            <dd>{{ describe.range.visibleCount }}</dd>
            <dt>{{ t('components.input.contextDetail.summarized') }}</dt>
            <dd>{{ describe.range.summarizedCount }}</dd>
            <dt>{{ t('components.input.contextDetail.lastSummary') }}</dt>
            <dd>{{ formatIndex(describe.range.lastSummaryIndex) }}</dd>
            <dt>{{ t('components.input.contextDetail.trimStart') }}</dt>
            <dd>{{ formatIndex(describe.range.trimStartIndex) }}</dd>
            <dt>{{ t('components.input.contextDetail.fallback') }}</dt>
            <dd>
              {{
                describe.range.fallbackActive
                  ? t('components.input.contextDetail.fallbackActive')
                  : t('components.input.contextDetail.fallbackInactive')
              }}
            </dd>
            <dt>{{ t('components.input.contextDetail.policy') }}</dt>
            <dd>{{ policyLabel }}</dd>
          </dl>

          <p v-if="detailError" class="usage-error" role="alert">{{ detailError }}</p>
          <p v-if="describe.summaries.length === 0" class="usage-state">
            {{ t('components.input.contextDetail.emptySummaries') }}
          </p>
          <div
            v-for="summary in describe.summaries"
            :key="summary.id ?? `index-${summary.index}`"
            class="usage-summary"
          >
            <div class="usage-summary-head">
              <span>{{ formatIndex(summary.index) }}</span>
              <span class="usage-badge">
                {{ t(`components.input.contextDetail.${summary.isAutoSummary ? 'auto' : 'manual'}`) }}
              </span>
              <span v-if="typeof summary.summarizedMessageCount === 'number'">
                {{ t('components.input.contextDetail.summarizedCount', { count: summary.summarizedMessageCount }) }}
              </span>
              <button
                type="button"
                class="usage-link"
                :disabled="!summary.id || detailLoading"
                @click="openDetail(summary.id)"
              >
                {{ t('components.input.contextDetail.viewDetail') }}
              </button>
            </div>
            <p class="usage-summary-preview">{{ summary.preview || t('components.input.contextDetail.noDetail') }}</p>
            <div v-if="summary.summaryTokenStats || typeof summary.timestamp === 'number'" class="usage-summary-meta">
              <span v-if="typeof summary.timestamp === 'number'">{{ formatTime(summary.timestamp, 'YYYY-MM-DD HH:mm') }}</span>
              <span v-if="summary.summaryTokenStats">
                {{ formatNumber(toSummaryTokenView(summary.summaryTokenStats)!.before) }}
                →
                {{ formatNumber(toSummaryTokenView(summary.summaryTokenStats)!.after) }}
                (−{{ formatNumber(toSummaryTokenView(summary.summaryTokenStats)!.saved) }})
              </span>
            </div>
          </div>
        </template>

        <template v-else-if="detail">
          <button type="button" class="usage-link" @click="backToList">
            {{ t('components.input.contextDetail.backToList') }}
          </button>
          <dl class="usage-facts">
            <dt>{{ t('components.input.contextDetail.indexLabel') }}</dt>
            <dd>{{ formatIndex(detail.summary.index) }}</dd>
            <template v-if="typeof detail.summary.timestamp === 'number'">
              <dt>{{ t('components.input.contextDetail.timeLabel') }}</dt>
              <dd>{{ formatTime(detail.summary.timestamp, 'YYYY-MM-DD HH:mm') }}</dd>
            </template>
            <template v-if="detail.summary.summaryTokenStats">
              <dt>{{ t('components.input.contextDetail.tokenSaved') }}</dt>
              <dd>
                {{ formatNumber(toSummaryTokenView(detail.summary.summaryTokenStats)!.before) }}
                →
                {{ formatNumber(toSummaryTokenView(detail.summary.summaryTokenStats)!.after) }}
              </dd>
            </template>
          </dl>
          <p class="usage-summary-full">{{ detail.summary.preview || t('components.input.contextDetail.noDetail') }}</p>
        </template>
      </details>
    </template>
  </section>
</template>

<style scoped>
.context-usage {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: var(--gc-layer-popover);
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
  width: min(360px, 100%);
  padding: var(--gc-space-3);
  overflow-y: auto;
  background: var(--gc-surface-raised);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  box-shadow: var(--gc-shadow-md);
  font-size: 12px;
}

/* 内容超出时面板自身滚动，子项不能被弹性布局压缩，否则占用条会先被压没。 */
.context-usage > * {
  flex-shrink: 0;
}

.usage-head {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.usage-title {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--gc-text-primary);
}

.usage-model {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-refresh {
  flex-shrink: 0;
  margin-left: auto;
}

.usage-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gc-space-3);
}

.usage-total-percent {
  color: var(--gc-text-primary);
  font-size: 15px;
  font-weight: 600;
}

.usage-total-percent.warning {
  color: var(--gc-warning);
}

.usage-total-percent.danger {
  color: var(--gc-danger);
}

.usage-total-tokens {
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  font-size: var(--gc-font-size-caption);
}

/* 槽底就是剩余空间：已用分类从左连续排列，缓冲和预留用斜纹区分“占着但还没写入”。 */
.usage-bar {
  display: flex;
  height: 8px;
  overflow: hidden;
  background: var(--gc-surface-hover);
}

.usage-segment {
  flex: 0 0 auto;
  min-width: 2px;
  height: 100%;
  background: var(--usage-color);
}

.usage-segment.expandable {
  cursor: pointer;
}

.usage-color-messages { --usage-color: var(--gc-chart-blue); }
.usage-color-systemTools { --usage-color: var(--gc-chart-orange); }
.usage-color-memory { --usage-color: var(--gc-chart-green); }
.usage-color-systemPrompt { --usage-color: var(--gc-chart-yellow); }
.usage-color-mcpTools { --usage-color: var(--gc-chart-purple); }
.usage-color-dynamicContext { --usage-color: var(--gc-chart-teal); }
.usage-color-freeSpace,
.usage-color-systemToolsDeferred,
.usage-color-mcpToolsDeferred { --usage-color: var(--gc-surface-hover); }
.usage-color-reservedOutput,
.usage-color-autoCompactBuffer {
  --usage-color: repeating-linear-gradient(135deg, var(--gc-text-muted) 0 2px, transparent 2px 4px);
}

.usage-notice {
  margin: 0;
  color: var(--gc-warning);
  font-size: var(--gc-font-size-caption);
  line-height: 1.5;
}

.usage-rows,
.usage-items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.usage-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto 44px 14px;
  align-items: center;
  gap: var(--gc-space-2);
  width: 100%;
  padding: 3px 4px;
  color: var(--gc-text-primary);
  background: none;
  border: none;
  border-radius: var(--gc-radius-xs);
  font: inherit;
  text-align: left;
}

.usage-row.expandable {
  cursor: pointer;
}

.usage-row.expandable:hover {
  background: var(--gc-surface-hover);
}

.usage-row.uncounted .usage-row-label,
.usage-row.uncounted .usage-row-percent {
  color: var(--gc-text-muted);
}

.usage-swatch {
  width: 10px;
  height: 10px;
  background: var(--usage-color);
}

.usage-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-row-tokens,
.usage-row-percent,
.usage-item-tokens {
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  font-size: var(--gc-font-size-caption);
  text-align: right;
}

.usage-row-percent {
  color: var(--gc-text-primary);
}

.usage-chevron {
  color: var(--gc-text-muted);
  font-size: 12px;
  transition: transform var(--gc-duration-fast) var(--gc-ease-standard);
}

.usage-chevron.open {
  transform: rotate(90deg);
}

.usage-items {
  margin: 0 0 var(--gc-space-1) 22px;
  padding-left: var(--gc-space-2);
  border-left: 1px solid var(--gc-border-subtle);
}

.usage-item {
  display: flex;
  align-items: baseline;
  gap: var(--gc-space-2);
  padding: 2px 4px;
}

.usage-item-label {
  min-width: 0;
  overflow: hidden;
  color: var(--gc-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-item-detail {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-item-tokens {
  flex-shrink: 0;
  margin-left: auto;
}

.usage-note,
.usage-state {
  margin: 0;
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  line-height: 1.5;
}

.usage-state {
  padding: var(--gc-space-1) 0;
}

.usage-error {
  margin: 0;
  color: var(--gc-danger);
  line-height: 1.5;
  word-break: break-word;
}

.usage-details {
  padding-top: var(--gc-space-2);
  border-top: 1px solid var(--gc-border-subtle);
}

.usage-details summary {
  color: var(--gc-text-muted);
  cursor: pointer;
}

.usage-details[open] summary {
  margin-bottom: var(--gc-space-2);
}

.usage-facts {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px var(--gc-space-3);
  margin: 0 0 var(--gc-space-2);
}

.usage-facts dt {
  color: var(--gc-text-muted);
}

.usage-facts dd {
  margin: 0;
  color: var(--gc-text-primary);
  text-align: right;
}

.usage-summary {
  padding: var(--gc-space-2) 0;
  border-top: 1px solid var(--gc-border-subtle);
}

.usage-summary-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gc-space-2);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
}

.usage-badge {
  padding: 0 6px;
  color: var(--gc-badge-fg);
  background: var(--gc-badge-bg);
  border-radius: var(--gc-radius-xs);
}

.usage-link {
  padding: 0;
  color: var(--gc-link);
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
}

.usage-summary-head .usage-link {
  margin-left: auto;
}

.usage-link:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.usage-summary-preview,
.usage-summary-full {
  margin: var(--gc-space-1) 0 0;
  color: var(--gc-text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.usage-summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gc-space-2);
  margin-top: var(--gc-space-1);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
}

@media (prefers-reduced-motion: reduce) {
  .usage-chevron {
    transition: none;
  }
}
</style>
