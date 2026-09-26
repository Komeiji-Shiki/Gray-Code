<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import { toolStatusLabel } from '../../../utils/toolPresentation'
import { record, text, type ResultRecord } from './automationResult'
const props = defineProps<{ value: ResultRecord }>()
const { t } = useI18n()
const state = computed(() => text(props.value.status))
const label = computed(() => state.value === 'unknown' || !state.value ? t('components.tools.automation.operationUnknown')
  : state.value === 'dispatching' ? t('components.tools.automation.dispatching') : toolStatusLabel(state.value) || state.value)
const observationError = computed(() => record(props.value.observationError))
</script>

<template>
  <div class="automation-receipt">
    <div class="automation-item-head">
      <span class="automation-muted">{{ t('components.tools.automation.operationStatus') }}</span>
      <span class="automation-badge action-status" :class="{ 'is-good': state === 'completed', 'is-error': state === 'failed', 'is-warning': !state || ['unknown', 'dispatching'].includes(state) }" :title="state">{{ label }}</span>
    </div>
    <p v-if="value.repeated === true" class="automation-muted">{{ t('components.tools.automation.repeated') }}</p>
    <div v-if="Object.keys(observationError).length" class="automation-notice observation-error" role="status">
      <strong>{{ t('components.tools.automation.observationUnavailable') }}</strong>
      <div>{{ text(observationError.message) }}</div><code v-if="observationError.code" class="automation-code">{{ text(observationError.code) }}</code>
    </div>
  </div>
</template>

<style scoped src="./automation.css"></style>
