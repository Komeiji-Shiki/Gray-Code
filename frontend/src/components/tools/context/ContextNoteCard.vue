<script setup lang="ts">
import { computed } from 'vue'
import { hasMessage, useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'

const props = defineProps<{ note: Record<string, unknown> }>()
const { t } = useI18n()
const body = computed(() => typeof props.note.text === 'string' ? props.note.text : '')
const about = computed(() => Array.isArray(props.note.about) ? props.note.about.filter((value): value is string => typeof value === 'string') : [])
const sources = computed(() => Array.isArray(props.note.sources) ? props.note.sources.filter(recordValue) : [])
const relations = computed(() => Array.isArray(props.note.relations) ? props.note.relations.filter(recordValue) : [])
const label = (group: string, value: unknown) => {
  if (typeof value !== 'string') return ''
  const key = `components.tools.contextNotes.${group}.${value}`
  return hasMessage(key) ? t(key) : value
}
</script>

<template>
  <article class="context-note-card" :class="{ 'note-unavailable': note.state === 'source_unavailable' || note.state === 'outside_time' }">
    <header>
      <strong>{{ label('kinds', note.kind) || note.key || t('components.tools.presentation.noteContent') }}</strong>
      <span v-if="note.kind && note.key" class="note-key">{{ note.key }}</span>
      <span v-if="note.state" class="note-state" :class="{ 'state-current': note.state === 'current', 'state-warning': note.state !== 'current' }">{{ label('states', note.state) }}</span>
      <span v-if="note.confidence" class="note-confidence">{{ t(`components.tools.platform.memory.confidence.${note.confidence}`) }}</span>
      <span v-if="note.origin" class="note-origin">{{ t(`components.tools.platform.memory.origins.${note.origin}`) }}</span>
      <span v-if="typeof note.text === 'string'" class="character-count">{{ t('components.tools.presentation.characters', { count: body.length }) }}</span>
    </header>
    <code v-if="note.id" class="note-id">{{ note.id }}</code>
    <pre v-if="typeof note.text === 'string'" class="document-text">{{ body }}</pre>
    <p v-else class="context-warning">{{ t('components.tools.presentation.contentUnavailable') }}</p>
    <p v-if="about.length" class="note-about"><span>{{ t('components.tools.contextNotes.about') }}</span>{{ about.join(' · ') }}</p>
    <div v-if="relations.length" class="note-relations">
      <div v-for="(relation, index) in relations" :key="index"><span>{{ label('relations', relation.kind) }}</span><code>{{ relation.target }}</code></div>
    </div>
    <div v-if="sources.length" class="note-sources">
      <span>{{ t('components.tools.platform.memory.sources') }}</span>
      <div v-for="(source, index) in sources" :key="index">
        <code>{{ source.messageId }}</code>
        <span v-if="typeof source.offset === 'number' && typeof source.length === 'number'">{{ t('components.tools.contextNotes.sourceRange', { offset: source.offset, length: source.length }) }}</span>
        <pre v-if="typeof source.quote === 'string'">{{ source.quote }}</pre>
      </div>
    </div>
    <p v-if="note.truncated" class="context-warning">{{ t('components.tools.presentation.partialContent') }}<span v-if="typeof note.nextOffset === 'number'"> {{ t('components.tools.contextNotes.nextOffset', { offset: note.nextOffset }) }}</span></p>
  </article>
</template>

<style scoped>
.note-state.state-current{color:var(--vscode-testing-iconPassed)}
.context-note-card{min-width:0;border-left:2px solid var(--vscode-focusBorder);padding:10px 12px;margin:10px 0;background:var(--vscode-textCodeBlock-background)}.context-note-card.note-unavailable{border-color:var(--vscode-editorWarning-foreground)}header{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;font-size:12px}.note-key,.note-state,.note-confidence,.note-origin,.character-count{font-size:11px;color:var(--vscode-descriptionForeground)}.note-state{color:var(--vscode-editorWarning-foreground)}.character-count{margin-left:auto;white-space:nowrap}code{font-size:10px;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.note-id{display:block;margin-top:6px}.document-text,.note-sources pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.65;margin:10px 0 0;max-height:480px;overflow:auto}.note-about,.note-relations,.note-sources,.context-warning{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.65;margin:8px 0 0;overflow-wrap:anywhere}.note-about>span,.note-relations span{margin-right:8px}.note-relations>div{display:flex;align-items:baseline;gap:4px}.note-relations span{flex-shrink:0}.note-sources>div{padding-top:4px}.note-sources>div>span{margin-left:8px}.note-sources pre{margin-top:4px;max-height:160px}
</style>
