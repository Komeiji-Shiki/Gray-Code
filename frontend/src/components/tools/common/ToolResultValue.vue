<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue, toolFieldLabel, toolImage, toolLink, toolStatusLabel, toolTextValue } from '../../../utils/toolPresentation'

const props = withDefaults(defineProps<{ value: unknown; depth?: number; field?: string; omit?: string[] }>(), { depth: 0, field: '', omit: () => [] })
const { t } = useI18n()
const expanded = ref(props.depth === 1 && ['content', 'nodes', 'matches', 'tasks', 'tabs', 'windows', 'entries'].includes(props.field))
const visible = ref(20), textLimit = ref(3000)
const value = computed(() => toolTextValue(props.value))
const image = computed(() => toolImage(value.value))
const byteLength = computed(() => value.value instanceof Uint8Array ? value.value.byteLength : undefined)
const link = computed(() => toolLink(value.value))
const entries = computed(() => recordValue(value.value) ? Object.entries(value.value).filter(([key, item]) => item !== undefined && !props.omit.includes(key)) : [])
const statusLabel = computed(() => props.field === 'status' ? toolStatusLabel(value.value) : undefined)
const items = computed(() => Array.isArray(value.value) ? value.value : [])
const collection = computed(() => Array.isArray(value.value) || recordValue(value.value))
const count = computed(() => Array.isArray(value.value) ? items.value.length : entries.value.length)
const contentVisible = computed(() => props.depth === 0 || expanded.value)
const text = computed(() => value.value === null ? 'null' : String(value.value ?? ''))
watch(() => props.value, () => { visible.value = 20; textLimit.value = 3000 })

function toggle(event: Event) { expanded.value = (event.target as HTMLDetailsElement).open }
function summary(item: unknown): { key: string; text: string } | undefined {
  if (!recordValue(item)) return undefined
  const key = ['title', 'name', 'path', 'role', 'id'].find(key => typeof item[key] === 'number' || typeof item[key] === 'string' && item[key] !== '')
  return key ? { key, text: String(item[key]) } : undefined
}
</script>

<template>
  <figure v-if="image" class="result-image">
    <img :src="image" :alt="recordValue(value) ? String(value.name ?? t('components.tools.structured.image')) : t('components.tools.structured.image')" loading="lazy" />
    <figcaption v-if="recordValue(value) && value.name">{{ value.name }}</figcaption>
  </figure>
  <span v-else-if="byteLength !== undefined" class="result-muted">{{ t('components.tools.structured.binary', { count: byteLength }) }}</span>
  <component :is="depth > 0 ? 'details' : 'div'" v-else-if="collection" class="result-group" :open="depth > 0 ? expanded : undefined" @toggle="toggle">
    <summary v-if="depth > 0" class="result-group-summary">{{ t('components.tools.structured.items', { count }) }}</summary>
    <template v-if="contentVisible">
      <span v-if="!count" class="result-muted">{{ t('components.tools.structured.empty') }}</span>
      <ol v-else-if="Array.isArray(value)" class="result-list">
        <li v-for="(item, index) in items.slice(0, visible)" :key="index">
          <span class="result-index">{{ index + 1 }}</span>
          <div class="result-list-body"><div v-if="summary(item)" class="result-item-title">{{ summary(item)?.text }}</div><ToolResultValue :value="item" :depth="recordValue(item) ? 0 : depth + 1" :omit="[summary(item)?.key ?? '']" /></div>
        </li>
      </ol>
      <dl v-else class="result-fields">
        <div v-for="[key, item] in entries.slice(0, visible)" :key="key" class="result-field">
          <dt :title="key">{{ toolFieldLabel(key) }}</dt>
          <dd><ToolResultValue :value="item" :depth="depth + 1" :field="key" /></dd>
        </div>
      </dl>
      <button v-if="count > visible" type="button" class="result-more" @click="visible += 20">{{ t('components.tools.structured.showMore', { count: count - visible }) }}</button>
    </template>
  </component>
  <a v-else-if="link" :href="link" target="_blank" rel="noopener noreferrer" class="result-link">{{ value }}<span aria-hidden="true" class="codicon codicon-link-external" /></a>
  <span v-else-if="typeof value === 'boolean'" class="result-boolean" :class="{ 'is-true': value }" :title="String(value)">{{ t(`components.tools.structured.${value ? 'yes' : 'no'}`) }}</span>
  <span v-else-if="statusLabel" class="result-status" :title="text" :class="{ 'is-complete': ['completed', 'done', 'success'].includes(text), 'is-failed': ['error', 'failed'].includes(text) }">{{ statusLabel }}</span>
  <span v-else-if="typeof value === 'number'" class="result-number">{{ value }}</span>
  <div v-else class="result-text-wrap"><pre class="result-text">{{ text.slice(0, textLimit) }}</pre><button v-if="text.length > textLimit" type="button" class="result-more" @click="textLimit += 12000">{{ t('components.tools.structured.moreText', { count: text.length - textLimit }) }}</button></div>
</template>

<style scoped>
.result-group,.result-list-body,.result-text-wrap{min-width:0}.result-group-summary{cursor:pointer;color:var(--vscode-descriptionForeground);padding:3px 0;font-size:12px}.result-group[open]>.result-group-summary{margin-bottom:7px}.result-fields{margin:0;display:grid;gap:0}.result-field{display:grid;grid-template-columns:minmax(90px,130px) minmax(0,1fr);gap:12px;padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.result-field:last-child{border-bottom:0}dt{font-size:11px;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}dd{margin:0;min-width:0}.result-list{list-style:none;padding:0;margin:0}.result-list>li{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}.result-list>li:last-child{border-bottom:0}.result-index{flex:0 0 24px;text-align:right;color:var(--vscode-descriptionForeground);font:11px var(--vscode-editor-font-family,monospace);padding-top:2px}.result-list-body{flex:1}.result-item-title{font-size:12px;font-weight:600;overflow-wrap:anywhere;margin-bottom:5px}.result-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.65 var(--vscode-editor-font-family,monospace);color:var(--vscode-foreground)}.result-link{display:inline-flex;gap:5px;max-width:100%;align-items:baseline;color:var(--vscode-textLink-foreground);font-size:12px;overflow-wrap:anywhere;word-break:break-word;text-decoration:none}.result-link:hover{text-decoration:underline}.result-number{font:12px var(--vscode-editor-font-family,monospace);color:var(--vscode-foreground)}.result-boolean{font-size:11px;border:1px solid var(--vscode-panel-border);padding:1px 6px;color:var(--vscode-descriptionForeground)}.result-boolean.is-true{color:var(--vscode-testing-iconPassed)}.result-muted{font-size:12px;color:var(--vscode-descriptionForeground)}.result-more{display:block;margin-top:8px;padding:5px 0;border:0;border-radius:0;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:11px;cursor:pointer}.result-more:hover{text-decoration:underline}.result-image{margin:0;max-width:100%}.result-image img{display:block;max-width:100%;max-height:400px;object-fit:contain;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}figcaption{font-size:11px;color:var(--vscode-descriptionForeground);padding-top:6px;overflow-wrap:anywhere}button:focus-visible,a:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}@media(max-width:480px){.result-field{grid-template-columns:minmax(65px,90px) minmax(0,1fr);gap:8px}}
.result-fields{container-type:inline-size}
.result-status{display:inline-block;font-size:11px;padding:2px 6px;border:1px solid var(--vscode-panel-border);color:var(--vscode-textLink-foreground)}
.result-status.is-complete{color:var(--vscode-testing-iconPassed)}
.result-status.is-failed{color:var(--vscode-errorForeground)}
@container(max-width:260px){.result-field{grid-template-columns:minmax(0,1fr);gap:4px}.result-field dt{font-size:10px}}
</style>
