<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import { actionLabel, numeric, record, text, type ResultRecord } from './automationResult'
const props = defineProps<{ value: ResultRecord; title: string }>()
const { t } = useI18n()
const parameters = computed(() => Object.entries(record(props.value.parameters)).filter(([, value]) => numeric(value) !== undefined))
const duration = computed(() => numeric(props.value.durationMs) ?? (numeric(props.value.expiresAt) !== undefined && numeric(props.value.createdAt) !== undefined ? Number(props.value.expiresAt) - Number(props.value.createdAt) : undefined))
const hasAngle = computed(() => Object.prototype.hasOwnProperty.call(props.value, 'angle'))
</script>

<template>
  <section v-if="Object.keys(value).length" class="automation-section pet-command">
    <div class="automation-section-title"><h4>{{ title }}</h4></div>
    <div class="automation-item-head"><span class="automation-badge">{{ actionLabel(value.action) }}</span><strong v-if="value.id">{{ text(value.id) }}</strong></div>
    <dl v-if="duration !== undefined || hasAngle || value.actorId" class="automation-fields">
      <div v-if="duration !== undefined"><dt>{{ t('components.tools.automation.duration') }}</dt><dd>{{ duration }} ms</dd></div>
      <div v-if="hasAngle"><dt>{{ t('components.tools.automation.lookAngle') }}</dt><dd>{{ value.angle === null ? t('components.tools.automation.front') : `${text(value.angle)}°` }}</dd></div>
      <div v-if="value.actorId"><dt>{{ t('components.tools.automation.controller') }}</dt><dd>{{ text(value.actorId) }}<div v-if="value.runId" class="automation-code">{{ text(value.runId) }}</div></dd></div>
    </dl>
    <div v-if="parameters.length" class="automation-table-wrap"><table class="automation-table"><thead><tr><th>{{ t('components.tools.parameters') }}</th><th>{{ t('components.tools.structured.fields.value') }}</th></tr></thead><tbody><tr v-for="[id, value] in parameters" :key="id"><td><code>{{ id }}</code></td><td>{{ value }}</td></tr></tbody></table></div>
    <div v-if="value.requestId" class="automation-meta">{{ t('components.tools.automation.requestId') }} <code>{{ text(value.requestId) }}</code></div>
  </section>
</template>

<style scoped src="./automation.css"></style>
