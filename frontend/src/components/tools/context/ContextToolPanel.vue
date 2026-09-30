<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import ContextNotesPanel from './ContextNotesPanel.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ args?: Record<string, unknown>; result?: unknown; error?: string; status?: string; toolName?: string }>()
const { t } = useI18n()
const data = computed(() => recordValue(props.result) ? recordValue(props.result.data) ? props.result.data : props.result : {})
const notesTool = computed(() => props.toolName === 'context_notes')
const graphAction = computed(() => notesTool.value && ['record', 'recall', 'inspect'].includes(String(props.args?.action)))
const writing = computed(() => notesTool.value && ['write', 'append'].includes(String(props.args?.action)))
const title = computed(() => notesTool.value
  ? props.args?.action === 'append' ? t('components.tools.presentation.appendedContent') : t('components.tools.presentation.noteContent')
  : t('components.tools.presentation.historyMessages'))
const name = computed(() => typeof data.value.name === 'string' ? data.value.name : typeof props.args?.name === 'string' ? props.args.name : '')
const body = computed(() => writing.value ? typeof props.args?.text === 'string' ? props.args.text : '' : typeof data.value.text === 'string' ? data.value.text : '')
const entries = computed(() => {
  const values = notesTool.value ? data.value.notes : data.value.items ?? data.value.windows
  return Array.isArray(values) ? values.filter(recordValue) : []
})
const hasBody = computed(() => writing.value || typeof data.value.text === 'string')
const count = computed(() => body.value.length)
</script>
<template>
  <ContextNotesPanel v-if="graphAction" v-bind="props" />
  <ToolResultPanel v-else v-bind="props">
    <section v-if="hasBody" class="context-document">
      <header><span class="codicon" :class="notesTool ? 'codicon-note' : 'codicon-history'" aria-hidden="true" /><strong>{{ title }}</strong><span class="character-count">{{ t('components.tools.presentation.characters', { count }) }}</span></header>
      <p v-if="name" class="document-name">{{ name }}</p>
      <p v-if="data.invalidated" class="context-warning">{{ t('components.tools.presentation.invalidatedNote') }}</p>
      <pre class="document-text">{{ body }}</pre>
      <p v-if="data.truncated" class="context-warning">{{ t('components.tools.presentation.partialContent') }}</p>
    </section>
    <template #result="{ payload, metadata }">
      <section v-if="entries.length" class="context-list">
        <h4>{{ t(notesTool ? 'components.tools.presentation.noteDirectory' : 'components.tools.presentation.historyMessages') }}</h4>
        <article v-for="(entry, index) in entries" :key="String(entry.messageId ?? entry.windowId ?? entry.name ?? index)">
          <header><strong>{{ entry.name ?? entry.role ?? entry.windowId }}</strong><code v-if="entry.messageId">{{ entry.messageId }}</code><span v-if="entry.count !== undefined">{{ t('components.tools.structured.items', { count: entry.count }) }}</span></header>
          <pre v-if="typeof entry.text === 'string'">{{ entry.text }}</pre>
        </article>
        <p v-if="data.nextBeforeId" class="context-warning">{{ t('components.tools.presentation.moreHistory') }}</p>
      </section>
      <p v-else-if="!hasBody && !error && recordValue(result) && result.success !== false" class="context-empty">{{ t('components.tools.structured.empty') }}</p>
      <ToolReceiptDetails :value="payload" :metadata="metadata" />
    </template>
  </ToolResultPanel>
</template>
<style scoped>
.context-document{min-width:0;border-left:2px solid var(--vscode-focusBorder);padding:10px 12px;margin-bottom:12px;background:var(--vscode-textCodeBlock-background)}header{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px}.character-count{margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.document-name{font-family:var(--vscode-editor-font-family);font-size:11px;overflow-wrap:anywhere;color:var(--vscode-descriptionForeground);margin:8px 0}.document-text,.context-list pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.65;margin:10px 0 0;max-height:480px;overflow:auto}.context-list article{border-top:1px solid var(--vscode-panel-border);padding:10px 0}.context-list header{flex-wrap:wrap}.context-list code{font-size:10px;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.context-list h4{margin:0 0 8px;font-size:12px}.context-warning,.context-empty{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:8px 0}
</style>
