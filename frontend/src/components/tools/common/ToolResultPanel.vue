<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue, toolRawData } from '../../../utils/toolPresentation'
import ToolResultValue from './ToolResultValue.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ args?: Record<string, unknown>; result?: unknown; error?: string; status?: string; toolName?: string }>()
const { t } = useI18n()
const rawOpen = ref(false)
const hasResult = computed(() => props.result !== undefined && props.result !== null)
const envelope = computed(() => recordValue(props.result) ? props.result : undefined)
const failure = computed(() => props.error || (typeof envelope.value?.error === 'string' ? envelope.value.error : ''))
const hasData = computed(() => !!envelope.value && Object.hasOwn(envelope.value, 'data'))
const metadata = computed(() => envelope.value ? Object.fromEntries(Object.entries(envelope.value)
  .filter(([key]) => !['success', 'data', 'error', 'attachments', 'multimodal'].includes(key))) : {})
const payload = computed(() => hasData.value ? envelope.value?.data : envelope.value ? metadata.value : props.result)
const media = computed(() => [envelope.value?.attachments, envelope.value?.multimodal].flatMap(value => Array.isArray(value) ? value : []))
const resultEmpty = computed(() => payload.value === undefined || payload.value === null || recordValue(payload.value) && !Object.keys(payload.value).length)
const raw = computed(() => rawOpen.value ? toolRawData({ args: props.args, result: props.result, error: props.error }) : '')
const waiting = computed(() => !hasResult.value && !failure.value && ['queued', 'streaming', 'executing', 'awaiting_approval', 'background'].includes(props.status ?? ''))
</script>

<template>
  <div class="tool-result-panel">
    <div v-if="failure" class="result-error" role="alert"><span class="codicon codicon-error" aria-hidden="true" /><span>{{ failure }}</span></div>
    <section v-if="hasResult" class="result-section" :aria-label="t('components.tools.result')">
      <div class="result-heading"><span class="codicon codicon-output" aria-hidden="true" /><span>{{ t('components.tools.result') }}</span><span v-if="envelope?.success !== undefined" class="result-outcome" :class="{ failed: envelope.success === false }">{{ t(`components.tools.${envelope.success === false ? 'failed' : 'executed'}`) }}</span></div>
      <ToolResultValue v-if="!resultEmpty" :value="payload" />
      <p v-else-if="!failure && !media.length" class="result-empty">{{ t(envelope?.success === false ? 'components.tools.failed' : 'components.tools.structured.noOutput') }}</p>
      <ToolResultValue v-if="hasData && Object.keys(metadata).length" :value="metadata" />
      <div v-if="media.length" class="result-media"><ToolResultValue v-for="(item, index) in media" :key="index" :value="item" /></div>
    </section>
    <p v-if="waiting" class="result-waiting" role="status"><span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{{ t('components.tools.structured.waiting') }}</p>
    <details v-if="args && Object.keys(args).length" class="result-parameters" :open="!hasResult">
      <summary>{{ t('components.tools.parameters') }}<span>{{ Object.keys(args).length }}</span></summary>
      <ToolResultValue :value="args" />
    </details>
    <details class="result-raw" @toggle="rawOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('components.tools.structured.rawData') }}</summary>
      <ToolResultValue v-if="rawOpen" :value="raw" />
    </details>
  </div>
</template>

<style scoped>
.tool-result-panel{min-width:0;color:var(--vscode-foreground);font-size:12px}.result-section{padding:2px 0 10px}.result-heading{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:9px}.result-outcome{margin-left:auto;border-left:2px solid var(--vscode-testing-iconPassed);padding-left:7px;color:var(--vscode-testing-iconPassed);font-weight:400}.result-outcome.failed{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}.result-parameters,.result-raw{border-top:1px solid var(--vscode-panel-border);padding:9px 0}.result-parameters>summary,.result-raw>summary{cursor:pointer;color:var(--vscode-descriptionForeground);font-size:11px}.result-parameters>summary>span{margin-left:8px;opacity:.7}.result-parameters[open]>summary,.result-raw[open]>summary{margin-bottom:8px}.result-error{display:flex;align-items:baseline;gap:8px;border-left:2px solid var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground);padding:10px 12px;margin-bottom:12px;color:var(--vscode-errorForeground);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.result-empty,.result-waiting{margin:8px 0;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.6}.result-waiting{display:flex;align-items:center;gap:8px}.result-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px;margin-top:12px}summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}
</style>
