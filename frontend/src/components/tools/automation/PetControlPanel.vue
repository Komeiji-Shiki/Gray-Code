<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { hasMessage, useI18n } from '../../../i18n'
import { getToolDisplayName } from '../../../utils/toolLocalization'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import PetCommandDetails from './PetCommandDetails.vue'
import { actionLabel, numeric, payload, record, records, safeAutomationResult, text, type AutomationProps } from './automationResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<AutomationProps>()
const { t } = useI18n()
const safeResult = computed(() => safeAutomationResult(props.result))
const data = computed(() => payload(safeResult.value))
const state = computed(() => record(data.value.state))
const configuration = computed(() => record(data.value.configuration))
const resource = computed(() => record(data.value.resource))
const actions = computed(() => records(resource.value.actions))
const expressions = computed(() => records(resource.value.expressions))
const parameters = computed(() => records(state.value.parameters))
const current = computed(() => record(state.value.current || data.value.current))
const confirmed = computed(() => record(data.value.command || state.value.applied))
const phaseLabel = computed(() => {
  const key = `components.tools.automation.phases.${text(state.value.phase)}`
  return hasMessage(key) ? t(key) : text(state.value.phase)
})
const visible = ref(30)
watch(() => props.result, () => { visible.value = 30 })
</script>

<template>
  <div class="automation-panel pet-control-panel">
    <ToolResultPanel :args="args" :result="safeResult" :error="error" :status="status" :tool-name="toolName">
      <div class="automation-heading"><span class="codicon codicon-smiley" aria-hidden="true" /><div><div class="automation-kicker">{{ getToolDisplayName('pet_control') }}</div><h3>{{ actionLabel(args?.action) }}</h3></div></div>
      <template #result>
        <div v-if="typeof data.accepted === 'boolean' || typeof data.applied === 'boolean'" class="automation-item-head pet-receipt">
          <span v-if="typeof data.accepted === 'boolean'" class="automation-badge pet-accepted" :class="{ 'is-warning': !data.accepted }">{{ t(`components.tools.automation.${data.accepted ? 'accepted' : 'notAccepted'}`) }}</span>
          <span v-if="typeof data.applied === 'boolean'" class="automation-badge pet-applied" :class="{ 'is-good': data.applied, 'is-warning': !data.applied }">{{ t(`components.tools.automation.${data.applied ? 'applied' : 'notApplied'}`) }}</span>
        </div>
        <section v-if="args?.action === 'query' && (data.configuration || data.state || data.resource)" class="pet-summary">
          <div class="automation-kicker">{{ t('components.tools.automation.petModel') }}</div>
          <div class="automation-item-head"><strong>{{ text(resource.name) || t('components.tools.automation.noPet') }}</strong><span v-if="resource.kind" class="automation-badge">{{ text(resource.kind) }}</span><span v-if="configuration.stopped === true" class="automation-badge is-warning">{{ t('components.tools.automation.stopped') }}</span></div>
          <div v-if="resource.description" class="automation-muted">{{ text(resource.description) }}</div>
          <dl class="automation-fields">
            <div v-if="state.phase"><dt>{{ t('components.tools.automation.renderer') }}</dt><dd><span class="automation-badge" :class="{ 'is-good': state.phase === 'ready', 'is-error': state.phase === 'failed' }">{{ phaseLabel }}</span></dd></div>
            <div v-if="typeof configuration.visible === 'boolean'"><dt>{{ t('components.tools.automation.visible') }}</dt><dd>{{ t(`components.tools.structured.${configuration.visible ? 'yes' : 'no'}`) }}</dd></div>
          </dl>
        </section>
        <div v-if="state.error" class="automation-notice automation-error" role="alert">{{ text(state.error) }}</div>
        <PetCommandDetails :value="current" :title="t('components.tools.automation.currentCommand')" />
        <PetCommandDetails :value="confirmed" :title="t('components.tools.automation.confirmedCommand')" />

        <section v-if="Array.isArray(resource.actions)" class="automation-section pet-actions"><div class="automation-section-title"><h4>{{ t('components.tools.automation.petActions') }}</h4><span class="automation-count">{{ actions.length }}</span></div><p v-if="!actions.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p><ul v-else class="automation-list"><li v-for="(action, index) in actions.slice(0, visible)" :key="text(action.id) || index"><div class="automation-item-head"><strong>{{ text(action.name) || text(action.id) }}</strong><span v-if="numeric(action.durationMs) !== undefined" class="automation-badge">{{ action.durationMs }} ms</span></div><div class="automation-meta"><code>{{ text(action.id) }}</code><span v-if="action.group">{{ text(action.group) }}</span></div></li></ul><button v-if="actions.length > visible" type="button" class="automation-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: actions.length - visible }) }}</button></section>
        <section v-if="Array.isArray(resource.expressions)" class="automation-section pet-expressions"><div class="automation-section-title"><h4>{{ t('components.tools.automation.expressions') }}</h4><span class="automation-count">{{ expressions.length }}</span></div><p v-if="!expressions.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p><ul v-else class="automation-list"><li v-for="(expression, index) in expressions.slice(0, visible)" :key="text(expression.id) || index"><strong>{{ text(expression.name) || text(expression.id) }}</strong><div class="automation-meta"><code>{{ text(expression.id) }}</code></div></li></ul><button v-if="expressions.length > visible" type="button" class="automation-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: expressions.length - visible }) }}</button></section>
        <section v-if="Array.isArray(state.parameters)" class="automation-section pet-parameters"><div class="automation-section-title"><h4>{{ t('components.tools.automation.parameterRanges') }}</h4><span class="automation-count">{{ parameters.length }}</span></div><p v-if="!parameters.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p><div v-else class="automation-table-wrap"><table class="automation-table"><thead><tr><th>{{ t('components.tools.parameters') }}</th><th>{{ t('components.tools.automation.range') }}</th><th>{{ t('components.tools.automation.defaultValue') }}</th></tr></thead><tbody><tr v-for="(parameter, index) in parameters.slice(0, visible)" :key="text(parameter.id) || index"><td><strong v-if="parameter.name">{{ text(parameter.name) }}</strong><div><code>{{ text(parameter.id) }}</code></div></td><td>{{ text(parameter.min) }} … {{ text(parameter.max) }}</td><td>{{ text(parameter.default) }}</td></tr></tbody></table></div><button v-if="parameters.length > visible" type="button" class="automation-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: parameters.length - visible }) }}</button></section>
        <p v-if="!Object.keys(data).filter(key => key !== 'success').length && !error && !record(result).error" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
      </template>
    </ToolResultPanel>
  </div>
</template>

<style scoped src="./automation.css"></style>
