<script setup lang="ts">
/**
 * ContextDetailDialog - 上下文统计只读展示
 *
 * 用量区域旁的详情入口（InputArea token 环旁）打开的只读对话框：
 * - 薄展示层：RPC 与整形全部委托 contextStats.ts；
 * - 只读：展示 describeConversation 的已用 Token/上限/使用率、可见与已总结范围、
 *   已保存总结明细，getSummaryDetail 看单条详情，不触发总结。
 */

import { computed, ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import { Modal } from '../common'
import { formatNumber, formatTime } from '@/utils/format'
import {
  extractRpcErrorMessage,
  isMissingHandlerError,
  resolveDisplayMaxTokens,
  resolveDisplayPercent,
  isPreciseSource,
  toSummaryTokenView,
  fetchContextDescribe,
  fetchSummaryDetail,
  type ContextDescribeResult,
  type ContextSummaryDetail
} from './contextStats'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  conversationId: string | null
  providerId?: string
  modelOverride?: string
  fallbackMaxTokens?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  close: []
}>()

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const loading = ref(false)
const error = ref('')
const desktopOnly = ref(false)
const describe = ref<ContextDescribeResult | null>(null)

const detailLoading = ref(false)
const detailError = ref('')
const detailDesktopOnly = ref(false)
const detail = ref<ContextSummaryDetail | null>(null)

const displayMax = computed(() =>
  resolveDisplayMaxTokens(describe.value?.tokens.maxContextTokens, props.fallbackMaxTokens)
)

const displayPercent = computed(() => {
  if (describe.value?.tokens.tokenUsagePercent !== undefined) {
    return describe.value.tokens.tokenUsagePercent
  }
  return resolveDisplayPercent(describe.value?.tokens.usedTokens ?? 0, displayMax.value)
})

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
  open.value = false
  emit('close')
}

function backToList() {
  detail.value = null
  detailError.value = ''
  detailDesktopOnly.value = false
}

async function loadDescribe() {
  if (!props.conversationId) {
    describe.value = null
    error.value = ''
    desktopOnly.value = false
    return
  }
  loading.value = true
  error.value = ''
  desktopOnly.value = false
  backToList()
  try {
    describe.value = await fetchContextDescribe(props.conversationId, {
      ...(props.providerId ? { providerId: props.providerId } : {}),
      ...(props.modelOverride ? { modelOverride: props.modelOverride } : {})
    })
  } catch (failure) {
    describe.value = null
    error.value = extractRpcErrorMessage(failure)
    desktopOnly.value = isMissingHandlerError(failure)
  } finally {
    loading.value = false
  }
}

async function openDetail(messageId: string | undefined) {
  if (!props.conversationId || !messageId) return
  detailLoading.value = true
  detailError.value = ''
  detailDesktopOnly.value = false
  try {
    detail.value = await fetchSummaryDetail(props.conversationId, messageId)
  } catch (failure) {
    detail.value = null
    detailError.value = extractRpcErrorMessage(failure)
    detailDesktopOnly.value = isMissingHandlerError(failure)
  } finally {
    detailLoading.value = false
  }
}

function formatPercentText(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
}

function formatCountText(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : '—'
}

function formatIndexText(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `#${value}` : '—'
}

function formatTrimText(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '—'
}

watch(
  () => props.modelValue,
  value => {
    if (value) void loadDescribe()
  }
)
</script>

<template>
  <Modal
    v-model="open"
    :title="t('components.input.contextDetail.title')"
    width="560px"
    @close="close"
  >
    <div class="context-detail">
      <div v-if="!conversationId" class="detail-empty">
        {{ t('components.input.contextDetail.noConversation') }}
      </div>

      <template v-else>
        <div class="detail-toolbar">
          <button
            type="button"
            class="gc-btn"
            :disabled="loading"
            @click="loadDescribe"
          >
            <i
              class="codicon"
              :class="loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"
              aria-hidden="true"
            ></i>
            <span>{{ t('components.input.contextDetail.refresh') }}</span>
          </button>
          <button
            v-if="detail"
            type="button"
            class="gc-btn"
            @click="backToList"
          >
            {{ t('components.input.contextDetail.backToList') }}
          </button>
        </div>

        <div v-if="loading" class="detail-loading">
          <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
          <span>{{ t('components.input.contextDetail.loading') }}</span>
        </div>

        <div v-else-if="error" class="detail-error" role="alert">
          <i class="codicon codicon-error" aria-hidden="true"></i>
          <span>
            <template v-if="desktopOnly">
              {{ t('components.input.contextDetail.desktopOnly') }}：{{ error }}
            </template>
            <template v-else>{{ error }}</template>
          </span>
        </div>

        <template v-else-if="describe && !detail">
          <section class="detail-section" :aria-label="t('components.input.contextDetail.tokensTitle')">
            <h4 class="detail-section-title">{{ t('components.input.contextDetail.tokensTitle') }}</h4>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.used') }}</span>
              <span class="detail-value">{{ formatCountText(describe.tokens.usedTokens) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.limit') }}</span>
              <span class="detail-value">{{ displayMax !== undefined ? formatCountText(displayMax) : '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.usage') }}</span>
              <span class="detail-value">{{ formatPercentText(displayPercent) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.source') }}</span>
              <span class="detail-value">{{ sourceLabel }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.localEstimate') }}</span>
              <span class="detail-value">{{ formatCountText(describe.tokens.localEstimate) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.preciseTokens') }}</span>
              <span class="detail-value">
                {{
                  describe.tokens.preciseAvailable && describe.tokens.preciseTokens !== undefined
                    ? formatCountText(describe.tokens.preciseTokens)
                    : t('components.input.contextDetail.preciseUnavailable')
                }}
              </span>
            </div>
          </section>

          <section class="detail-section" :aria-label="t('components.input.contextDetail.rangeTitle')">
            <h4 class="detail-section-title">{{ t('components.input.contextDetail.rangeTitle') }}</h4>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.total') }}</span>
              <span class="detail-value">{{ formatCountText(describe.range.total) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.visible') }}</span>
              <span class="detail-value">{{ formatCountText(describe.range.visibleCount) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.summarized') }}</span>
              <span class="detail-value">{{ formatCountText(describe.range.summarizedCount) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.summariesCount') }}</span>
              <span class="detail-value">{{ formatCountText(describe.range.summaryCount) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.lastSummary') }}</span>
              <span class="detail-value">{{ formatIndexText(describe.range.lastSummaryIndex) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.trimStart') }}</span>
              <span class="detail-value">{{ formatTrimText(describe.range.trimStartIndex) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.fallbackActive') }}</span>
              <span class="detail-value">
                {{
                  describe.range.fallbackActive
                    ? t('components.input.contextDetail.fallbackActive')
                    : t('components.input.contextDetail.fallbackInactive')
                }}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('components.input.contextDetail.policy') }}</span>
              <span class="detail-value">{{ policyLabel }}</span>
            </div>
          </section>

          <section class="detail-section" :aria-label="t('components.input.contextDetail.summariesTitle')">
            <h4 class="detail-section-title">{{ t('components.input.contextDetail.summariesTitle') }}</h4>
            <div v-if="describe.summaries.length === 0" class="detail-empty">
              {{ t('components.input.contextDetail.emptySummaries') }}
            </div>
            <div v-else class="summary-list">
              <div
                v-for="summary in describe.summaries"
                :key="summary.id ?? `index-${summary.index}`"
                class="summary-card"
              >
                <div class="summary-card-header">
                  <span class="summary-index">{{ t('components.input.contextDetail.indexLabel') }} {{ summary.index }}</span>
                  <span v-if="summary.isAutoSummary" class="summary-badge">
                    {{ t('components.input.contextDetail.auto') }}
                  </span>
                  <span v-else class="summary-badge manual">
                    {{ t('components.input.contextDetail.manual') }}
                  </span>
                  <span v-if="typeof summary.summarizedMessageCount === 'number'" class="summary-count">
                    {{ t('components.input.contextDetail.summarizedCount', { count: summary.summarizedMessageCount }) }}
                  </span>
                </div>
                <p class="summary-preview">{{ summary.preview || t('components.input.contextDetail.noDetail') }}</p>
                <div class="summary-meta">
                  <span v-if="typeof summary.timestamp === 'number'">
                    {{ t('components.input.contextDetail.timeLabel') }} {{ formatTime(summary.timestamp, 'YYYY-MM-DD HH:mm') }}
                  </span>
                  <span
                    v-if="summary.summaryTokenStats"
                    class="summary-tokens"
                  >
                    {{ t('components.input.contextDetail.tokenBefore') }} {{ formatCountText(toSummaryTokenView(summary.summaryTokenStats)?.before) }}
                    →
                    {{ t('components.input.contextDetail.tokenAfter') }} {{ formatCountText(toSummaryTokenView(summary.summaryTokenStats)?.after) }}
                    (−{{ formatCountText(toSummaryTokenView(summary.summaryTokenStats)?.saved) }})
                  </span>
                </div>
                <div class="summary-actions">
                  <button
                    type="button"
                    class="gc-btn"
                    :disabled="!summary.id || detailLoading"
                    @click="openDetail(summary.id)"
                  >
                    {{ t('components.input.contextDetail.viewDetail') }}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else-if="detail">
          <section class="detail-section" :aria-label="t('components.input.contextDetail.detailTitle')">
            <h4 class="detail-section-title">{{ t('components.input.contextDetail.detailTitle') }}</h4>
            <div v-if="detailLoading" class="detail-loading">
              <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
              <span>{{ t('components.input.contextDetail.loading') }}</span>
            </div>
            <div v-else-if="detailError" class="detail-error" role="alert">
              <i class="codicon codicon-error" aria-hidden="true"></i>
              <span>
                <template v-if="detailDesktopOnly">
                  {{ t('components.input.contextDetail.desktopOnly') }}：{{ detailError }}
                </template>
                <template v-else>{{ detailError }}</template>
              </span>
            </div>
            <template v-else>
              <div class="detail-row">
                <span class="detail-label">{{ t('components.input.contextDetail.indexLabel') }}</span>
                <span class="detail-value">{{ detail.summary.index }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{{ t('components.input.contextDetail.timeLabel') }}</span>
                <span class="detail-value">
                  {{
                    typeof detail.summary.timestamp === 'number'
                      ? formatTime(detail.summary.timestamp, 'YYYY-MM-DD HH:mm')
                      : '—'
                  }}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{{ t('components.input.contextDetail.summariesCount') }}</span>
                <span class="detail-value">
                  {{
                    typeof detail.summary.summarizedMessageCount === 'number'
                      ? t('components.input.contextDetail.summarizedCount', { count: detail.summary.summarizedMessageCount })
                      : '—'
                  }}
                </span>
              </div>
              <div
                v-if="detail.summary.summaryTokenStats"
                class="detail-row"
              >
                <span class="detail-label">{{ t('components.input.contextDetail.tokensTitle') }}</span>
                <span class="detail-value">
                  {{ t('components.input.contextDetail.tokenBefore') }} {{ formatCountText(toSummaryTokenView(detail.summary.summaryTokenStats)?.before) }}
                  →
                  {{ t('components.input.contextDetail.tokenAfter') }} {{ formatCountText(toSummaryTokenView(detail.summary.summaryTokenStats)?.after) }}
                  (−{{ formatCountText(toSummaryTokenView(detail.summary.summaryTokenStats)?.saved) }})
                </span>
              </div>
              <p class="detail-preview">{{ detail.summary.preview || t('components.input.contextDetail.noDetail') }}</p>
            </template>
          </section>
        </template>
      </template>
    </div>

    <template #footer>
      <button type="button" class="gc-btn" @click="close">
        {{ t('components.input.contextDetail.close') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.context-detail {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-4);
}

.detail-toolbar {
  display: flex;
  gap: var(--gc-space-2);
}

.gc-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  cursor: pointer;
}

.gc-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.detail-section {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--gc-radius-sm);
  padding: var(--gc-space-3);
  background: var(--vscode-editor-background);
}

.detail-section-title {
  margin: 0 0 var(--gc-space-2) 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.detail-row {
  display: flex;
  justify-content: space-between;
  gap: var(--gc-space-3);
  padding: 4px 0;
  font-size: 12px;
  line-height: 1.5;
}

.detail-label {
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.detail-value {
  color: var(--vscode-foreground);
  text-align: right;
  word-break: break-all;
}

.detail-loading,
.detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--gc-space-4);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}

.detail-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.summary-list {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
}

.summary-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--gc-radius-sm);
  padding: var(--gc-space-3);
}

.summary-card-header {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  flex-wrap: wrap;
  margin-bottom: var(--gc-space-2);
}

.summary-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.summary-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--gc-radius-md);
  background: rgba(221, 185, 47, 0.1);
  color: var(--vscode-charts-yellow, #ddb92f);
  border: 1px solid var(--vscode-focusBorder);
}

.summary-badge.manual {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-color: transparent;
}

.summary-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  padding: 2px 8px;
  border-radius: var(--gc-radius-md);
}

.summary-preview {
  margin: 0 0 var(--gc-space-2) 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
}

.summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gc-space-2);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: var(--gc-space-2);
}

.summary-actions {
  display: flex;
  justify-content: flex-end;
}

.detail-preview {
  margin: var(--gc-space-3) 0 0 0;
  padding: var(--gc-space-3);
  background: var(--vscode-textBlockQuote-background);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-foreground);
  max-height: 320px;
  overflow: auto;
}

.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
