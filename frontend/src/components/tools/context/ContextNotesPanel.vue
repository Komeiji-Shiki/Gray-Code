<script setup lang="ts">
import { computed } from 'vue'
import { hasMessage, useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import ContextNoteCard from './ContextNoteCard.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ args?: Record<string, unknown>; result?: unknown; error?: string; status?: string; toolName?: string }>()
const { t } = useI18n()
const data = computed(() => recordValue(props.result) ? recordValue(props.result.data) ? props.result.data : props.result : {})
const action = computed(() => String(props.args?.action ?? ''))
const failure = computed(() => props.error || (typeof data.value.error === 'string' ? data.value.error : ''))
const succeeded = computed(() => recordValue(props.result) && props.result.success !== false && data.value.success !== false && !failure.value)
const records = (value: unknown) => Array.isArray(value) ? value.filter(recordValue) : []
const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const receipt = computed(() => recordValue(data.value.noteEvent) ? data.value.noteEvent : {})
const eventRecords = computed(() => records(receipt.value.records))
const recordedNotes = computed(() => {
  // 记录调用没有返回确认等级或有效状态；不把额外参数当成服务端确认的元数据。
  const submitted = records(props.args?.entries).map(entry => ({ key: entry.key, kind: entry.kind, text: entry.text,
    about: entry.about, sources: entry.sources, relations: entry.relations }))
  if (!succeeded.value || !eventRecords.value.length) return submitted
  const entriesByKey = new Map(submitted.map(entry => [typeof entry.key === 'string' ? entry.key.trim() : entry.key, entry]))
  const idsByKey = new Map(eventRecords.value.map(record => [record.key, record.id]))
  // 回执只保存编号与来源；正文按同批 key 对应原调用，不按位置猜配，也不重复保存。
  return eventRecords.value.map(record => {
    const entry: Record<string, unknown> = entriesByKey.get(record.key) ?? {}
    return { ...entry, ...record,
      ...(typeof entry.text === 'string' ? { text: entry.text.trim() } : {}),
      about: [...new Set(ids(entry.about).map(value => value.trim()))],
      relations: records(entry.relations).map(relation => {
        const target = typeof relation.target === 'string' ? relation.target.trim() : relation.target
        return { ...relation, target: typeof target === 'string' && target.startsWith('@') ? idsByKey.get(target.slice(1)) ?? target : target }
      }) }
  })
})
const recalledNotes = computed(() => records(data.value.items))
const provided = computed(() => records(data.value.alreadyProvided))
const warnings = computed(() => ['missingDependencies', 'unavailable', 'omitted'].map(kind => ({ kind, ids: ids(data.value[kind]) })).filter(item => item.ids.length))
const replacements = computed(() => action.value === 'inspect'
  ? ids(data.value.replacements).length ? [{ id: data.value.id, currentIds: ids(data.value.replacements) }] : []
  : records(data.value.replacements).map(item => ({ id: item.id, currentIds: ids(item.currentIds) })))
const recallEmpty = computed(() => !recalledNotes.value.length && !provided.value.length && !warnings.value.length && !replacements.value.length && !data.value.truncated)
const providedReason = (value: unknown) => {
  const key = `components.tools.contextNotes.providedReasons.${String(value)}`
  return hasMessage(key) ? t(key) : ''
}
</script>

<template>
  <ToolResultPanel v-bind="props" :error="failure">
    <section v-if="action === 'record' && recordedNotes.length" class="context-records">
      <h4>{{ t(succeeded && eventRecords.length ? 'components.tools.contextNotes.recorded' : 'components.tools.contextNotes.submitted', { count: recordedNotes.length }) }}</h4>
      <ContextNoteCard v-for="(note, index) in recordedNotes" :key="String(note.id ?? note.key ?? index)" :note="note" />
    </section>
    <template #result="{ payload, metadata }">
      <template v-if="succeeded">
        <p v-if="action === 'record' && !recordedNotes.length" class="context-warning">{{ t('components.tools.presentation.contentUnavailable') }}</p>
        <template v-if="action === 'recall'">
          <div class="recall-summary">
            <strong>{{ t('components.tools.contextNotes.recalled', { count: recalledNotes.length }) }}</strong>
            <span v-if="typeof data.estimatedTokens === 'number' && typeof data.tokenBudget === 'number'">{{ t('components.tools.contextNotes.budget', { used: data.estimatedTokens, budget: data.tokenBudget }) }}</span>
          </div>
          <ContextNoteCard v-for="(note, index) in recalledNotes" :key="String(note.id ?? index)" :note="note" />
          <section v-if="provided.length" class="context-references">
            <h4>{{ t('components.tools.contextNotes.alreadyProvided', { count: provided.length }) }}</h4>
            <p>{{ t('components.tools.contextNotes.providedExplanation') }}</p>
            <div v-for="(note, index) in provided" :key="String(note.id ?? index)" class="provided-note">
              <code>{{ note.id }}</code><span>{{ providedReason(note.reason) }}</span>
              <span v-if="note.messageId">{{ t('components.tools.contextNotes.historyReference') }} <code>{{ note.messageId }}</code></span>
            </div>
          </section>
          <section v-for="warning in warnings" :key="warning.kind" class="context-warning-list">
            <h4>{{ t(`components.tools.contextNotes.${warning.kind}`, { count: warning.ids.length }) }}</h4>
            <code v-for="id in warning.ids" :key="id">{{ id }}</code>
          </section>
          <p v-if="data.truncated" class="context-warning">{{ t('components.tools.contextNotes.truncated') }}</p>
          <p v-if="recallEmpty" class="context-empty">{{ t('components.tools.contextNotes.empty') }}</p>
        </template>
        <ContextNoteCard v-if="action === 'inspect'" :note="data" />
        <section v-if="replacements.length" class="context-replacements">
          <h4>{{ t('components.tools.contextNotes.replacements') }}</h4>
          <div v-for="(replacement, index) in replacements" :key="String(replacement.id ?? index)">
            <code>{{ replacement.id }}</code><span class="codicon codicon-arrow-right" aria-hidden="true" /><code>{{ replacement.currentIds.join(' · ') }}</code>
          </div>
        </section>
      </template>
      <p v-if="typeof data.requiredTokenBudget === 'number'" class="context-warning">{{ t('components.tools.platform.memory.requiredBudget', { count: data.requiredTokenBudget }) }}</p>
      <ToolReceiptDetails :value="payload" :metadata="metadata" />
    </template>
  </ToolResultPanel>
</template>

<style scoped>
h4{margin:0 0 8px;font-size:12px}.recall-summary{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px;font-size:12px}.recall-summary>span{font-size:11px;color:var(--vscode-descriptionForeground)}.context-references,.context-warning-list,.context-replacements{border-top:1px solid var(--vscode-panel-border);padding:10px 0;margin-top:10px}.context-references p,.context-warning,.context-empty{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.65;margin:8px 0}.provided-note{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;font-size:11px;line-height:1.65;margin-top:6px;color:var(--vscode-descriptionForeground)}code{font-size:10px;overflow-wrap:anywhere;color:var(--vscode-descriptionForeground)}.context-warning-list{border-left:2px solid var(--vscode-editorWarning-foreground);padding-left:10px}.context-warning-list h4{color:var(--vscode-editorWarning-foreground)}.context-warning-list>code{display:block;line-height:1.65}.context-replacements>div{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;line-height:1.65}
</style>
