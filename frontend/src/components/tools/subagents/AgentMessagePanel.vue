<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ args?: Record<string, unknown>; result?: unknown; error?: string; status?: string; toolName?: string }>()
const { t } = useI18n()
const data = computed(() => recordValue(props.result) ? recordValue(props.result.data) ? props.result.data : props.result : {})
const body = computed(() => typeof props.args?.message === 'string' ? props.args.message : '')
const recipient = computed(() => {
  const name = typeof props.args?.targetAgentName === 'string' ? props.args.targetAgentName.trim() : ''
  const id = typeof props.args?.targetRunId === 'string' ? props.args.targetRunId.trim() : ''
  const target = id || name || (typeof data.value.toRunId === 'string' ? data.value.toRunId : '')
  return ['main', '__main__'].includes(target) ? t('components.tools.presentation.mainAgent') : target
})
</script>
<template>
  <ToolResultPanel v-bind="props">
    <section class="agent-message-body">
      <header><span class="codicon codicon-send" aria-hidden="true" /><strong>{{ t('components.tools.presentation.messageBody') }}</strong></header>
      <p v-if="recipient" class="recipient"><span>{{ t('components.tools.presentation.recipient') }}</span><code>{{ recipient }}</code></p>
      <pre v-if="body" class="message-text">{{ body }}</pre>
      <p v-else class="unavailable">{{ t('components.tools.presentation.contentUnavailable') }}</p>
    </section>
    <template #result="{ payload, metadata }">
      <p v-if="!error && recordValue(result) && result.success === true" class="delivery-note">{{ t('components.tools.presentation.messageSaved') }}</p>
      <ToolReceiptDetails :value="payload" :metadata="metadata" />
    </template>
  </ToolResultPanel>
</template>
<style scoped>
.agent-message-body{border-left:2px solid var(--vscode-focusBorder);padding:10px 12px;margin-bottom:12px;min-width:0;background:var(--vscode-textCodeBlock-background)}header{display:flex;align-items:center;gap:8px;font-size:12px}.recipient{display:flex;align-items:baseline;gap:10px;color:var(--vscode-descriptionForeground);font-size:11px;margin:9px 0}.recipient code{overflow-wrap:anywhere;white-space:pre-wrap}.message-text{margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.65;max-height:480px;overflow:auto}.delivery-note,.unavailable{color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.6;margin:8px 0}
</style>
