<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '../../../i18n'
import ToolResultValue from './ToolResultValue.vue'
defineProps<{ value?: unknown; metadata?: unknown }>()
const { t } = useI18n()
const open = ref(false)
</script>
<template>
  <details class="tool-receipt-details" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>{{ t('components.tools.viewDetails') }}</summary>
    <template v-if="open"><ToolResultValue :value="value" /><ToolResultValue v-if="metadata && Object.keys(metadata as object).length" :value="metadata" /></template>
  </details>
</template>
<style scoped>
.tool-receipt-details{border-top:1px solid var(--vscode-panel-border);padding:8px 0;color:var(--vscode-descriptionForeground);font-size:11px}.tool-receipt-details>summary{cursor:pointer}.tool-receipt-details[open]>summary{margin-bottom:8px}summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}
</style>
