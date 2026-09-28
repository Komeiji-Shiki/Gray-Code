<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ args?: Record<string, unknown>; result?: unknown; error?: string; status?: string; toolName?: string }>()
const { t, actualLanguage } = useI18n()
const label = (key: string) => t(`components.tools.contextStatus.${key}`)
const data = computed(() => recordValue(props.result) ? recordValue(props.result.data) ? props.result.data : props.result : {})
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const format = (value: unknown) => finite(value) === undefined ? '—' : (value as number).toLocaleString(actualLanguage.value, { maximumFractionDigits: 2 })
const used = computed(() => finite(data.value.estimatedInputTokens))
const budget = computed(() => finite(data.value.maxInputTokens))
const usage = computed(() => finite(data.value.inputUsagePercent) ?? (used.value !== undefined && budget.value ? used.value / budget.value * 100 : undefined))
const percent = computed(() => usage.value === undefined ? '—' : `${format(usage.value)}%`)
const progress = computed(() => Math.min(100, usage.value ?? 0))
const remaining = computed(() => finite(data.value.remainingInputTokens) ?? (budget.value !== undefined && used.value !== undefined ? Math.max(0, budget.value - used.value) : undefined))
const hasMetrics = computed(() => used.value !== undefined || budget.value !== undefined)
const state = computed(() => {
  if (data.value.exceedsInputBudget === true || used.value !== undefined && budget.value !== undefined && used.value > budget.value) return 'overBudget'
  if (data.value.overThreshold === true || used.value !== undefined && finite(data.value.thresholdTokens) !== undefined && used.value > Number(data.value.thresholdTokens)) return 'overThreshold'
  return usage.value === undefined ? 'unknown' : 'normal'
})
const method = computed(() => label(data.value.method === 'notes' ? 'notes' : data.value.method === 'summary' ? 'summary' : 'unknown'))
const retention = computed(() => label(data.value.userMessageRetention === 'all' ? 'retainAll' : data.value.userMessageRetention === 'first' ? 'retainFirst' : data.value.userMessageRetention === 'bot-managed' ? 'retainBot' : 'unknown'))
const threshold = computed(() => {
  const raw = data.value.threshold
  return typeof raw === 'string' && /^\d+(?:\.\d+)?%$/.test(raw) ? raw : format(data.value.thresholdTokens ?? raw)
})
const measuredAt = computed(() => {
  const value = finite(data.value.measuredAt)
  if (value === undefined || Number.isNaN(new Date(value).getTime())) return '—'
  return new Date(value).toLocaleString(actualLanguage.value)
})
const detailsOpen = ref(false)
watch(() => props.result, () => { detailsOpen.value = false })
const details = computed(() => [
  ['fixedPrompt', format(data.value.fixedPromptTokens)], ['history', format(data.value.historyTokens)],
  ['messages', format(data.value.messageCount)], ['measuredAt', measuredAt.value],
  ['thresholdTokens', format(data.value.thresholdTokens)],
  ['contextId', data.value.windowId === 'initial' ? label('initial') : String(data.value.windowId ?? '—')],
])
</script>

<template>
  <ToolResultPanel v-bind="props" :hide-heading="true">
    <template #result>
      <section v-if="hasMetrics" class="context-status" :class="state" :aria-label="label('title')">
        <header class="usage-heading"><span>{{ label('title') }}</span><span class="usage-state">{{ label(state) }}</span></header>
        <div class="usage-total"><strong>{{ format(used) }}</strong><span>/ {{ format(budget) }} token</span><span class="usage-percent">{{ percent }}</span></div>
        <div v-if="usage !== undefined" class="usage-track" role="progressbar" :aria-label="label('title')" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="percent"><span :style="{ width: `${progress}%` }" /></div>
        <dl class="usage-stats">
          <div><dt>{{ label('remaining') }}</dt><dd>{{ format(remaining) }}</dd></div>
          <div><dt>{{ label('reservedOutput') }}</dt><dd>{{ format(data.reservedOutputTokens) }}</dd></div>
          <div><dt>{{ label('capacity') }}</dt><dd>{{ format(data.maxContextTokens) }}</dd></div>
        </dl>
        <dl class="usage-policy">
          <div><dt>{{ label('threshold') }}</dt><dd>{{ threshold }}</dd></div>
          <div><dt>{{ label('method') }}</dt><dd>{{ method }}<span v-if="data.managementEnabled === false" class="policy-disabled"> · {{ label('disabled') }}</span></dd></div>
          <div><dt>{{ label('retention') }}</dt><dd>{{ retention }}</dd></div>
        </dl>
        <p v-if="data.pendingWindowSwitch === true" class="usage-pending">{{ label('pending') }}</p>
        <footer class="usage-footer"><span>{{ label(data.source === 'local-estimate' ? 'localEstimate' : 'usageSource') }}</span><details :open="detailsOpen" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open"><summary>{{ label('details') }}</summary><dl v-if="detailsOpen" class="usage-details"><div v-for="[key, value] in details" :key="key"><dt>{{ label(key) }}</dt><dd>{{ value }}</dd></div></dl></details></footer>
      </section>
      <p v-else-if="!error && data.success !== false && !(recordValue(result) && result.success === false)" class="usage-empty">{{ label('empty') }}</p>
    </template>
  </ToolResultPanel>
</template>

<style scoped>
.context-status{--usage-color:var(--vscode-textLink-foreground);min-width:0;container-type:inline-size}.context-status.overThreshold{--usage-color:var(--vscode-editorWarning-foreground)}.context-status.overBudget{--usage-color:var(--vscode-errorForeground)}.usage-heading{display:flex;justify-content:space-between;gap:12px;color:var(--vscode-descriptionForeground);font-size:11px}.usage-state{color:var(--usage-color)}.usage-total{display:flex;align-items:baseline;flex-wrap:wrap;gap:7px;margin:10px 0;font-variant-numeric:tabular-nums}.usage-total strong{font-size:24px;font-weight:600;line-height:1.2}.usage-total>span{font-size:11px;color:var(--vscode-descriptionForeground)}.usage-total .usage-percent{margin-left:auto;color:var(--usage-color);font-size:13px}.usage-track{height:4px;overflow:hidden;background:var(--vscode-panel-border)}.usage-track>span{display:block;height:100%;background:var(--usage-color)}dl{margin:0}dt{font-size:11px;color:var(--vscode-descriptionForeground)}dd{margin:0;overflow-wrap:anywhere}.usage-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:12px 0}.usage-stats dd{font-size:13px;margin-top:4px;font-variant-numeric:tabular-nums}.usage-policy{border-top:1px solid var(--vscode-panel-border);padding:10px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:9px 16px}.usage-policy dd{font-size:12px;line-height:1.5;margin-top:3px}.policy-disabled,.usage-empty{color:var(--vscode-descriptionForeground)}.usage-pending{font-size:11px;color:var(--vscode-editorWarning-foreground);margin:0 0 8px}.usage-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;color:var(--vscode-descriptionForeground);font-size:11px}.usage-footer details[open]{flex-basis:100%}.usage-footer summary{cursor:pointer}.usage-details{margin-top:9px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px 16px}.usage-details>div{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px}.usage-details dd{color:var(--vscode-foreground)}summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}@container(max-width:300px){.usage-total strong{font-size:21px}.usage-stats{gap:8px}.usage-stats dd{font-size:12px}.usage-policy{grid-template-columns:1fr}.usage-policy>div{display:flex;justify-content:space-between;gap:12px}.usage-policy dd{margin:0;text-align:right}}
</style>
