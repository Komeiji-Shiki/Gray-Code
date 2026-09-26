<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { getToolDisplayName } from '../../../utils/toolLocalization'
import { toolFieldLabel } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolResultValue from '../common/ToolResultValue.vue'
import { actionLabel, fileSize, numeric, payload, record, records, text, type AutomationProps } from './automationResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<AutomationProps>()
const { t } = useI18n()
const data = computed(() => payload(props.result))
const documents = computed(() => records(data.value.documents))
const body = computed(() => typeof data.value.text === 'string' ? data.value.text : undefined)
const start = computed(() => numeric(data.value.offset))
const end = computed(() => start.value !== undefined && body.value !== undefined ? start.value + body.value.length : undefined)
const visible = ref(20)
watch(() => props.result, () => { visible.value = 20 })
</script>

<template>
  <div class="automation-panel bot-attachment-panel">
    <ToolResultPanel :args="args" :result="result" :error="error" :status="status" :tool-name="toolName">
      <div class="automation-heading"><span class="codicon codicon-attach" aria-hidden="true" /><div><div class="automation-kicker">{{ getToolDisplayName('bot_read_attachment') }}</div><h3>{{ actionLabel(args?.action) }}</h3></div></div>
      <template #result>
        <section v-if="Array.isArray(data.documents)" class="attachment-directory">
          <div class="automation-section-title"><h4>{{ t('components.tools.automation.attachments') }}</h4><span class="automation-count">{{ documents.length }}</span></div>
          <p v-if="!documents.length" class="automation-empty">{{ t('components.tools.automation.noAttachments') }}</p>
          <ul v-else class="automation-list"><li v-for="(document, index) in documents.slice(0, visible)" :key="text(document.id) || index"><div class="automation-item-head"><span class="codicon codicon-file-text" aria-hidden="true" /><strong>{{ text(document.name) }}</strong><span v-if="fileSize(document.sizeBytes)" class="automation-badge">{{ fileSize(document.sizeBytes) }}</span></div><div class="automation-meta"><span v-if="document.encoding">{{ t('components.tools.automation.encoding') }} · {{ text(document.encoding) }}</span><code>{{ text(document.id) }}</code></div><div class="automation-meta automation-code">{{ text(document.path) }}</div></li></ul>
          <button v-if="documents.length > visible" type="button" class="automation-more" @click="visible += 20">{{ t('components.tools.structured.showMore', { count: documents.length - visible }) }}</button>
        </section>
        <section v-if="data.name || data.path || data.id" class="attachment-document">
          <div class="automation-item-head"><span class="codicon codicon-file-text" aria-hidden="true" /><strong>{{ text(data.name) || text(data.id) }}</strong><span v-if="fileSize(data.sizeBytes)" class="automation-badge">{{ fileSize(data.sizeBytes) }}</span></div>
          <dl class="automation-fields"><div v-if="data.id"><dt>{{ toolFieldLabel('id') }}</dt><dd class="automation-code">{{ text(data.id) }}</dd></div><div v-if="data.encoding"><dt>{{ t('components.tools.automation.encoding') }}</dt><dd>{{ text(data.encoding) }}</dd></div><div v-if="data.path"><dt>{{ toolFieldLabel('path') }}</dt><dd class="automation-code">{{ text(data.path) }}</dd></div></dl>
        </section>
        <section v-if="body !== undefined" class="automation-section attachment-body">
          <div class="automation-section-title"><h4>{{ toolFieldLabel('text') }}</h4><span v-if="start !== undefined && end !== undefined" class="automation-muted">{{ t('components.tools.automation.characterRange', { start, end }) }}</span></div>
          <div v-if="body" class="automation-content"><ToolResultValue :value="body" /></div><p v-else class="automation-empty">{{ t('components.tools.automation.emptyText') }}</p>
          <p v-if="data.truncated === true" class="automation-notice">{{ t('components.tools.automation.truncated') }}<span v-if="numeric(data.nextOffset) !== undefined" class="attachment-next">{{ t('components.tools.automation.nextOffset') }} <code>{{ data.nextOffset }}</code></span></p>
          <p v-else-if="data.truncated === false" class="automation-muted">{{ t('components.tools.automation.endOfDocument') }}</p>
        </section>
        <p v-if="!Object.keys(data).filter(key => key !== 'success').length && !error && !record(result).error" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
      </template>
    </ToolResultPanel>
  </div>
</template>

<style scoped src="./automation.css"></style>
<style scoped>.attachment-next{display:block;margin-top:5px}.attachment-next code{font-family:var(--vscode-editor-font-family,monospace)}</style>
