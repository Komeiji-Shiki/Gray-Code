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
const parameters = computed(() => records(data.value.parameters ?? state.value.parameters))
const channels = computed(() => Object.entries(record(state.value.channels)).map(([channel, value]) => ({
  ...record(value), action: channel === 'motion' ? 'play' : channel,
})))
const stopped = computed(() => state.value.stopped === true || configuration.value.stopped === true)
const catalogs = computed(() => [
  { key: 'actions', title: t('components.tools.automation.petActions'), items: records(resource.value.actions) },
  { key: 'expressions', title: t('components.tools.automation.expressions'), items: records(resource.value.expressions) },
].filter(catalog => Array.isArray(resource.value[catalog.key])))
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
      <div class="automation-heading">
        <span class="codicon codicon-smiley" aria-hidden="true" />
        <div><div class="automation-kicker">{{ getToolDisplayName('pet_control') }}</div><h3>{{ actionLabel(args?.action) }}</h3></div>
      </div>
      <template #result>
        <div v-if="typeof data.accepted === 'boolean' || typeof data.applied === 'boolean'" class="automation-item-head pet-receipt">
          <span v-if="typeof data.accepted === 'boolean'" class="automation-badge pet-accepted" :class="{ 'is-warning': !data.accepted }">
            {{ t(`components.tools.automation.${data.accepted ? 'accepted' : 'notAccepted'}`) }}
          </span>
          <span v-if="typeof data.applied === 'boolean'" class="automation-badge pet-applied"
            :class="{ 'is-good': data.applied, 'is-warning': !data.applied }">
            {{ t(`components.tools.automation.${data.applied ? 'applied' : 'notApplied'}`) }}
          </span>
        </div>
        <section v-if="args?.action === 'query' && (data.configuration || data.state || data.resource)" class="pet-summary">
          <div class="automation-kicker">{{ t('components.tools.automation.petModel') }}</div>
          <div class="automation-item-head">
            <strong>{{ text(resource.name) || t('components.tools.automation.noPet') }}</strong>
            <span v-if="resource.kind" class="automation-badge">{{ text(resource.kind) }}</span>
            <span v-if="stopped" class="automation-badge is-warning">{{ t('components.tools.automation.stopped') }}</span>
          </div>
          <div v-if="resource.description" class="automation-muted">{{ text(resource.description) }}</div>
          <dl class="automation-fields">
            <div v-if="state.phase">
              <dt>{{ t('components.tools.automation.renderer') }}</dt>
              <dd><span class="automation-badge" :class="{ 'is-good': state.phase === 'ready', 'is-error': state.phase === 'failed' }">
                {{ phaseLabel }}
              </span></dd>
            </div>
            <div v-if="typeof configuration.visible === 'boolean'">
              <dt>{{ t('components.tools.automation.visible') }}</dt>
              <dd>{{ t(`components.tools.structured.${configuration.visible ? 'yes' : 'no'}`) }}</dd>
            </div>
          </dl>
        </section>
        <div v-if="state.error" class="automation-notice automation-error" role="alert">{{ text(state.error) }}</div>
        <PetCommandDetails :value="current" :title="t('components.tools.automation.currentCommand')" />
        <PetCommandDetails v-for="channel in channels" :key="channel.action" :value="channel"
          :title="t('components.tools.automation.currentCommand')" />
        <PetCommandDetails :value="confirmed" :title="t('components.tools.automation.confirmedCommand')" />

        <section v-for="catalog in catalogs" :key="catalog.key" class="automation-section" :class="`pet-${catalog.key}`">
          <div class="automation-section-title"><h4>{{ catalog.title }}</h4><span class="automation-count">{{ catalog.items.length }}</span></div>
          <p v-if="!catalog.items.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
          <ul v-else class="automation-list">
            <li v-for="(item, index) in catalog.items.slice(0, visible)" :key="text(item.id) || index">
              <div class="automation-item-head">
                <strong>{{ text(item.description) || text(item.name) || text(item.id) }}</strong>
                <span v-if="numeric(item.durationMs) !== undefined" class="automation-badge">{{ item.durationMs }} ms</span>
              </div>
              <div class="automation-meta"><code>{{ text(item.id) }}</code><span v-if="item.group">{{ text(item.group) }}</span></div>
            </li>
          </ul>
          <button v-if="catalog.items.length > visible" type="button" class="automation-more" @click="visible += 30">
            {{ t('components.tools.structured.showMore', { count: catalog.items.length - visible }) }}
          </button>
        </section>
        <section v-if="Array.isArray(data.parameters ?? state.parameters)" class="automation-section pet-parameters">
          <div class="automation-section-title">
            <h4>{{ t('components.tools.automation.parameterRanges') }}</h4><span class="automation-count">{{ parameters.length }}</span>
          </div>
          <p v-if="!parameters.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
          <div v-else class="automation-table-wrap">
            <table class="automation-table">
              <thead><tr><th>{{ t('components.tools.parameters') }}</th><th>{{ t('components.tools.automation.range') }}</th>
                <th>{{ t('components.tools.automation.defaultValue') }}</th></tr></thead>
              <tbody>
                <tr v-for="(parameter, index) in parameters.slice(0, visible)" :key="text(parameter.id) || index">
                  <td><strong v-if="parameter.name">{{ text(parameter.name) }}</strong><div><code>{{ text(parameter.id) }}</code></div></td>
                  <td>{{ text(parameter.min) }} … {{ text(parameter.max) }}</td><td>{{ text(parameter.default) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button v-if="parameters.length > visible" type="button" class="automation-more" @click="visible += 30">
            {{ t('components.tools.structured.showMore', { count: parameters.length - visible }) }}
          </button>
        </section>
        <p v-if="!Object.keys(data).filter(key => key !== 'success').length && !error && !record(result).error" class="automation-empty">
          {{ t('components.tools.structured.empty') }}
        </p>
      </template>
    </ToolResultPanel>
  </div>
</template>

<style scoped src="./automation.css"></style>
