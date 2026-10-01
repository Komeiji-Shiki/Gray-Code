<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import PlatformText from './PlatformText.vue'
import MemoryRecordCard from './MemoryRecordCard.vue'
import { label, number, object, pick, records, resultBody, strings, successfulResult, text, type PlatformToolProps } from './platformResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<PlatformToolProps>()
const { t } = useI18n()
const args = computed(() => props.args ?? {})
const data = computed(() => object(resultBody(props.result)))
const succeeded = computed(() => successfulResult(props))
const topics = computed(() => records(data.value.topics))
const scopes = computed(() => records(data.value.scopes))
const sources = computed(() => records(data.value.sources))
const items = computed(() => props.toolName === 'memory_search'
  ? records(data.value.hits).filter(hit => recordValue(hit.record)).map(hit => ({ record: object(hit.record), evidence: pick(hit, ['score', 'reasons', 'conflicts']) }))
  : records(data.value.records).map(record => ({ record, evidence: undefined })))
const page = computed(() => object(data.value.page))
const hasPage = computed(() => typeof page.value.text === 'string')
const pageRecord = computed(() => ({ ...object(page.value.source ?? page.value.record), text: page.value.text }))
const mutation = computed(() => ['memory_remember', 'memory_revise', 'memory_summarize'].includes(props.toolName ?? ''))
const preview = computed(() => props.toolName === 'memory_remove' && (args.value.operation === 'preview' || Array.isArray(data.value.affected)))
const removed = computed(() => props.toolName === 'memory_remove' && args.value.operation === 'apply' && !preview.value && succeeded.value && number(data.value.removed) !== undefined)
const visible = ref(30)
watch(() => props.result, () => { visible.value = 30 })
const knownCollection = computed(() => ['records', 'hits', 'topics'].some(key => Array.isArray(data.value[key])))
</script>

<template>
  <div class="platform-panel long-memory-result"><ToolResultPanel v-bind="props">
    <div v-if="strings(args.topic).length || (toolName === 'memory_search' && text(args.text))" class="platform-header">
      <span v-if="strings(args.topic).length" class="platform-breadcrumb">{{ strings(args.topic).join(' › ') }}</span>
      <code v-if="toolName === 'memory_search'" class="platform-query">{{ text(args.text) }}</code>
    </div>
    <template #result="{ metadata }">
      <template v-if="toolName === 'memory_topics'">
        <section v-if="scopes.length" class="memory-scopes">
          <h4 class="platform-section-title">{{ t('components.tools.platform.memory.scopes') }}</h4>
          <div class="platform-statbar"><span v-for="(scope, index) in scopes" :key="index" class="platform-badge">{{ text(scope.label) || label('memory.scopeKinds', scope.kind) }}<span v-if="scope.realm && scope.realm !== 'real'"> · {{ scope.realm }}</span></span></div>
        </section>
        <h4 class="platform-section-title">{{ t('components.tools.platform.memory.topics') }}</h4>
        <article v-for="(topic, index) in topics.slice(0, visible)" :key="index" class="platform-card memory-topic">
          <h4 class="platform-card-title"><strong class="platform-breadcrumb">{{ strings(topic.path).join(' › ') || t('components.tools.platform.memory.root') }}</strong><span v-if="number(topic.records) !== undefined" class="platform-badge">{{ t('components.tools.platform.memory.records', { count: topic.records }) }}</span></h4>
          <MemoryRecordCard v-for="(summary, summaryIndex) in records(topic.summaries)" :key="summaryIndex" :record="{ ...summary, kind: 'summary' }" />
          <ToolReceiptDetails :value="pick(topic, ['scopeId'])" />
        </article>
        <button v-if="topics.length > visible" class="platform-more" type="button" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: topics.length - visible }) }}</button>
        <p v-if="!topics.length" class="platform-empty">{{ t(knownCollection ? 'components.tools.platform.memory.empty' : 'components.tools.platform.noData') }}</p>
      </template>
      <template v-else-if="toolName === 'memory_remove'">
        <div v-if="preview" class="platform-notice warning removal-preview">
          <strong>{{ t('components.tools.platform.memory.preview') }}</strong>
          <p v-if="number(data.total) !== undefined && number(data.recordCount) !== undefined">{{ t('components.tools.platform.memory.affected', { total: data.total, records: data.recordCount }) }}</p>
          <p v-if="data.truncated === true">{{ t('components.tools.platform.partial') }}</p>
          <h4 v-if="records(data.affected).length" class="platform-section-title">{{ t('components.tools.platform.memory.previewIds') }}</h4>
          <ToolReceiptDetails v-if="records(data.affected).length" :value="data.affected" />
        </div>
        <div v-else-if="removed" class="removal-receipt">
          <h4 class="platform-section-title">{{ t(`components.tools.platform.memory.${args.action === 'retract' ? 'retract' : 'apply'}`) }}</h4>
          <p class="platform-success">{{ t('components.tools.platform.memory.removed', { count: data.removed }) }}</p>
        </div>
        <p v-else class="platform-empty">{{ t('components.tools.platform.noData') }}</p>
      </template>
      <template v-else>
        <p v-if="mutation && succeeded && items.length" class="platform-success memory-save-receipt">{{ t('components.tools.platform.memory.saved', { count: items.length }) }}</p>
        <MemoryRecordCard v-for="(item, index) in items.slice(0, visible)" :key="index" :record="item.record" :evidence="item.evidence" />
        <button v-if="items.length > visible" class="platform-more" type="button" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: items.length - visible }) }}</button>
        <section v-if="hasPage" class="memory-page">
          <h4 class="platform-section-title">{{ t(`components.tools.platform.memory.${page.source ? 'sourcePage' : 'recordPage'}`) }}</h4>
          <div v-if="number(page.offset) !== undefined && number(page.end) !== undefined && number(page.totalCharacters) !== undefined" class="platform-statbar">{{ t('components.tools.platform.memory.pageRange', { start: page.offset, end: page.end, total: page.totalCharacters }) }}</div>
          <MemoryRecordCard :record="pageRecord" :source="!!page.source" />
          <p v-if="number(page.nextOffset) !== undefined" class="platform-notice continuation">{{ t('components.tools.platform.nextOffset', { offset: page.nextOffset }) }}<span v-if="number(object(page.record).version) !== undefined"> · {{ t('components.tools.platform.version', { version: object(page.record).version }) }}</span></p>
        </section>
        <p v-if="!items.length && !hasPage && !sources.length" class="platform-empty">{{ t(knownCollection ? 'components.tools.platform.memory.empty' : 'components.tools.platform.noData') }}</p>
        <section v-if="sources.length" class="memory-sources">
          <h4 class="platform-section-title">{{ t('components.tools.platform.memory.sources') }}</h4>
          <MemoryRecordCard v-for="(source, index) in sources.slice(0, visible)" :key="index" :record="source" source />
          <button v-if="sources.length > visible" class="platform-more" type="button" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: sources.length - visible }) }}</button>
        </section>
        <!-- 写入回执只有编号与版本，输入正文必须明确标作提交内容，不能冒充返回的事实。 -->
        <section v-if="mutation" class="memory-submitted">
          <template v-if="typeof args.text === 'string'"><h4 class="platform-section-title">{{ t('components.tools.platform.memory.requested') }}</h4><PlatformText :text="args.text" /></template>
          <template v-else-if="typeof args.append === 'string'"><h4 class="platform-section-title">{{ t('components.tools.platform.memory.append') }}</h4><PlatformText :text="args.append" /></template>
          <template v-else-if="typeof args.oldText === 'string' || typeof args.newText === 'string'">
          <h4 class="platform-section-title">{{ t('components.tools.platform.memory.requested') }}</h4>
          <div class="platform-columns memory-replacement">
            <div class="platform-column"><h4 class="platform-section-title">{{ t('components.tools.platform.file.before') }}</h4><PlatformText :text="text(args.oldText)" /></div>
            <div class="platform-column"><h4 class="platform-section-title">{{ t('components.tools.platform.file.after') }}</h4><PlatformText :text="text(args.newText)" /></div>
          </div></template>
        </section>
      </template>
      <p v-if="records(data.omitted).length" class="platform-notice warning memory-omitted">{{ t('components.tools.platform.memory.omitted', { count: records(data.omitted).length }) }}</p>
      <p v-if="records(data.unavailable).length" class="platform-notice warning memory-unavailable">{{ t('components.tools.platform.memory.unavailable', { count: records(data.unavailable).length }) }}</p>
      <p v-if="number(data.requiredTokenBudget) !== undefined" class="platform-notice warning">{{ t('components.tools.platform.memory.requiredBudget', { count: data.requiredTokenBudget }) }}</p>
      <p v-if="data.truncated === true && !preview" class="platform-notice warning">{{ t('components.tools.platform.memory.truncated') }}</p>
      <p v-if="text(data.nextCursor)" class="platform-notice continuation">{{ t('components.tools.platform.nextCursor') }}</p>
      <ToolReceiptDetails :value="{ ...pick(data, ['scopes', 'states', 'method', 'vectorModel', 'estimatedTokens', 'nextCursor', 'omitted', 'unavailable', 'revision']), ...(hasPage ? { page: pick(page, ['record', 'source', 'offset', 'nextOffset']) } : {}) }" :metadata="metadata" />
    </template>
  </ToolResultPanel></div>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.memory-topic :deep(.memory-card){padding-left:10px;border-left:2px solid var(--gc-border-subtle)}.memory-submitted{border-top:1px solid var(--gc-border-subtle);margin-top:10px}.removal-preview>p{margin:6px 0}.memory-scopes .platform-badge{font-size:11px}
</style>
