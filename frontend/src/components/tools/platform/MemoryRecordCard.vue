<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import PlatformText from './PlatformText.vue'
import { label, number, object, pick, records, strings, text } from './platformResult'

const props = defineProps<{ record: Record<string, unknown>; source?: boolean; evidence?: Record<string, unknown> }>()
const { t } = useI18n()
const topic = computed(() => strings(props.record.topic).join(' › '))
const reference = computed(() => object(props.record.reference))
const dependencies = computed(() => records(props.record.dependencies))
const conflicts = computed(() => strings(props.evidence?.conflicts))
</script>

<template>
  <article class="platform-card memory-card" :class="{ 'memory-source': source }">
    <div v-if="topic" class="platform-breadcrumb">{{ topic }}</div>
    <div class="platform-card-title">
      <strong v-if="text(record.subject) || text(reference.label)">{{ text(record.subject) || text(reference.label) }}</strong>
      <span v-if="source" class="platform-badge">{{ t('components.tools.platform.memory.source') }}</span>
      <span v-if="record.kind" class="platform-badge">{{ label('memory.kinds', record.kind) }}</span>
      <span v-if="record.confidence" class="platform-badge" :class="text(record.confidence)">{{ label('memory.confidence', record.confidence) }}</span>
      <span v-if="number(record.version) !== undefined" class="memory-version">{{ t('components.tools.platform.version', { version: record.version }) }}</span>
    </div>
    <div v-if="record.origin" class="platform-statbar">{{ label('memory.origins', record.origin) }}</div>
    <PlatformText v-if="typeof record.text === 'string'" :text="record.text" />
    <div v-if="dependencies.length" class="platform-statbar memory-dependencies">{{ t('components.tools.platform.memory.dependencies', { count: dependencies.length }) }}</div>
    <p v-if="conflicts.length" class="platform-notice warning memory-conflicts">{{ t('components.tools.platform.memory.conflicts', { count: conflicts.length }) }}</p>
    <ToolReceiptDetails :value="pick(record, ['id', 'scopeId', 'entities', 'attribute', 'value', 'recordedAt', 'validFrom', 'validTo', 'eventAt', 'dependencies', 'supersedes', 'reference', 'upstream'])" :metadata="evidence" />
  </article>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.memory-card>.platform-breadcrumb{margin-bottom:6px}.memory-version{font-size:10px;color:var(--gc-text-muted);font-weight:400;margin-left:auto}.memory-source{border-left:2px solid var(--gc-border-subtle);padding-left:10px}.platform-badge.disputed{color:var(--gc-warning)}.platform-badge.inferred{border-style:dashed}.platform-badge.confirmed{color:var(--gc-success)}
</style>
