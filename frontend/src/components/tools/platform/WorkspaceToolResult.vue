<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import ToolNextActions from '../common/ToolNextActions.vue'
import PlatformText from './PlatformText.vue'
import { label, number, object, pick, records, resultBody, strings, successfulResult, text, type PlatformToolProps } from './platformResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<PlatformToolProps>()
const { t } = useI18n()
const args = computed(() => props.args ?? {})
const payload = computed(() => resultBody(props.result))
const data = computed(() => object(payload.value))
const action = computed(() => text(args.value.action))
const search = computed(() => props.toolName === 'search_files')
const hasNextActions = computed(() => Array.isArray(data.value.nextActions) && data.value.nextActions.length > 0)
const succeeded = computed(() => successfulResult(props))
const entries = computed(() => records(payload.value))
const matches = computed(() => records(data.value.matches))
const visible = ref(40)
watch(() => props.result, () => { visible.value = 40 })
const groups = computed(() => {
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const match of matches.value.slice(0, visible.value)) {
    const path = text(match.path)
    if (!grouped.has(path)) grouped.set(path, [])
    grouped.get(path)!.push(match)
  }
  return [...grouped].map(([path, hits]) => ({ path, hits }))
})
const completeRange = computed(() => [data.value.startLine, data.value.endLine, data.value.totalLines].every(value => number(value) !== undefined))
const nextLine = computed(() => number(data.value.endLine) !== undefined && number(data.value.totalLines) !== undefined && Number(data.value.endLine) < Number(data.value.totalLines) ? Number(data.value.endLine) + 1 : undefined)
const mutation = computed(() => ['write', 'edit', 'delete'].includes(action.value))
</script>

<template>
  <div class="platform-panel workspace-result"><ToolResultPanel v-bind="props">
    <div class="platform-header">
      <strong>{{ search ? t('components.tools.structured.fields.query') : label('file.actions', action) }}</strong>
      <span v-if="args.path || args.directory" class="platform-path">{{ args.path || args.directory }}</span>
      <code v-if="search" class="platform-query">{{ text(args.query) }}</code>
    </div>
    <template #result="{ metadata }">
      <template v-if="search">
        <!-- 未扫完不能将当前页的零匹配当作全范围结论，续查参数直接沿用服务回执。 -->
        <div v-if="data.scanComplete === false" class="platform-notice warning" role="alert">
          {{ t(matches.length ? 'components.tools.platform.file.scanIncomplete' : 'components.tools.platform.file.scanIncompleteEmpty') }}
        </div>
        <div v-if="Array.isArray(data.matches)" class="platform-statbar">
          <span>{{ t('components.tools.platform.file.matches', { count: matches.length }) }}</span>
          <span v-if="number(data.scanned) !== undefined">{{ t('components.tools.platform.file.scanned', { count: data.scanned }) }}</span>
        </div>
        <article v-for="group in groups" :key="group.path" class="platform-card file-hits">
          <h4 class="platform-card-title platform-path"><span class="codicon codicon-file" aria-hidden="true" />{{ group.path }}</h4>
          <PlatformText v-for="(hit, index) in group.hits" :key="index" :text="text(hit.text)" :start-line="number(hit.line)" code />
        </article>
        <button v-if="matches.length > visible" class="platform-more" type="button" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: matches.length - visible }) }}</button>
        <p v-if="!matches.length && data.scanComplete !== false" class="platform-empty">{{ t(Array.isArray(data.matches) ? 'components.tools.platform.file.noMatches' : 'components.tools.platform.noData') }}</p>
        <div v-if="data.truncated === true && data.scanComplete !== false" class="platform-notice warning">
          {{ t(strings(data.truncationReasons).includes('scanLimit') ? 'components.tools.platform.file.scanLimit' : number(data.nextOffset) !== undefined || strings(data.truncationReasons).includes('limit') ? 'components.tools.platform.file.matchLimit' : 'components.tools.platform.partial') }}
        </div>
        <p v-if="number(data.nextOffset) !== undefined && !hasNextActions" class="platform-notice continuation">{{ t('components.tools.platform.nextOffset', { offset: data.nextOffset }) }}</p>
        <ToolNextActions :value="data.nextActions" />
      </template>
      <template v-else-if="action === 'list'">
        <ul class="platform-list file-entries">
          <li v-for="(entry, index) in entries.slice(0, visible)" :key="index"><span class="codicon" :class="entry.kind === 'directory' ? 'codicon-folder' : 'codicon-file'" aria-hidden="true" /><span class="platform-path">{{ text(entry.path) || text(entry.name) }}</span></li>
        </ul>
        <button v-if="entries.length > visible" class="platform-more" type="button" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: entries.length - visible }) }}</button>
        <p v-if="!entries.length" class="platform-empty">{{ t(Array.isArray(payload) ? 'components.tools.platform.file.empty' : 'components.tools.platform.noData') }}</p>
      </template>
      <template v-else-if="action === 'read'">
        <div v-if="completeRange" class="platform-statbar">{{ t('components.tools.platform.file.range', { start: data.startLine, end: data.endLine, total: data.totalLines }) }}</div>
        <PlatformText v-if="typeof data.content === 'string'" :text="data.content" :start-line="number(data.startLine)" code />
        <p v-else class="platform-empty">{{ t('components.tools.platform.noData') }}</p>
        <p v-if="nextLine !== undefined" class="platform-notice continuation">{{ t('components.tools.platform.file.nextLine', { line: nextLine }) }}</p>
      </template>
      <template v-else-if="mutation && succeeded">
        <p class="platform-success mutation-receipt">{{ t(`components.tools.platform.file.${action === 'delete' ? 'deleted' : 'saved'}`) }}</p>
        <template v-if="action === 'write' && typeof args.content === 'string'">
          <h4 class="platform-section-title">{{ t('components.tools.platform.file.requested') }}</h4>
          <PlatformText :text="args.content" code />
        </template>
        <div v-if="action === 'edit'" class="platform-columns file-replacement">
          <div class="platform-column"><h4 class="platform-section-title">{{ t('components.tools.platform.file.before') }}</h4><PlatformText :text="text(args.oldText)" code /></div>
          <div class="platform-column"><h4 class="platform-section-title">{{ t('components.tools.platform.file.after') }}</h4><PlatformText :text="text(args.newText)" code /></div>
        </div>
      </template>
      <p v-else class="platform-empty">{{ t('components.tools.platform.noData') }}</p>
      <ToolReceiptDetails :value="pick(data, ['hash', 'hashes', 'operationId', 'totalLines', 'offset', 'nextOffset', 'scanOffset', 'nextScanOffset', 'scanComplete', 'truncationReasons'])" :metadata="metadata" />
    </template>
  </ToolResultPanel></div>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.file-entries>li{display:flex;gap:9px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border)}.file-entries .codicon{color:var(--vscode-descriptionForeground)}.file-hits :deep(.platform-text)+:deep(.platform-text){margin-top:3px}.file-hits :deep(pre){max-height:140px;padding:6px 8px}
</style>
