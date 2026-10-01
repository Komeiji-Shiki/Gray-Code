<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { getToolDisplayName } from '../../../utils/toolLocalization'
import { toolFieldLabel } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import VisualActionReceipt from './VisualActionReceipt.vue'
import VisualObservation from './VisualObservation.vue'
import { actionLabel, dimensions, numeric, payload, record, records, safeAutomationResult, strings, text, type AutomationProps } from './automationResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<AutomationProps>()
const { t } = useI18n()
const safeResult = computed(() => safeAutomationResult(props.result))
const data = computed(() => payload(safeResult.value))
const observation = computed(() => props.toolName === 'computer_action' ? record(data.value.observation) : props.toolName === 'computer_observe' ? data.value : {})
const windows = computed(() => Array.isArray(data.value.windows) ? records(data.value.windows) : Object.keys(record(observation.value.window)).length ? [record(observation.value.window)] : [])
const displays = computed(() => records(data.value.displays))
const elements = computed(() => records(observation.value.elements))
const controller = computed(() => record(data.value.controller))
const visible = ref(30)
watch(() => props.result, () => { visible.value = 30 })
const focused = (element: Record<string, unknown>) => element.focused === true || element.id === observation.value.focusedElementId
</script>

<template>
  <div class="automation-panel computer-tool-panel">
    <ToolResultPanel :args="args" :result="safeResult" :error="error" :status="status" :tool-name="toolName">
      <div class="automation-heading"><span class="codicon codicon-device-desktop" aria-hidden="true" /><div><div class="automation-kicker">{{ getToolDisplayName(toolName || 'computer_observe') }}</div><h3>{{ actionLabel(args?.action) || text(args?.windowId) || toolFieldLabel('windows') }}</h3></div></div>
      <template #result>
        <VisualActionReceipt v-if="toolName === 'computer_action'" :value="data" />
        <div v-if="data.windowId && !windows.length" class="automation-meta">{{ toolFieldLabel('windowId') }} <code>{{ text(data.windowId) }}</code></div>

        <section v-if="toolName === 'computer_control' && typeof data.active === 'boolean'" class="computer-control">
          <div class="automation-item-head"><strong>{{ t('components.tools.automation.control') }}</strong><span class="automation-badge control-state" :class="{ 'is-good': data.active, 'is-warning': data.available === false }">{{ t(`components.tools.automation.${data.active ? 'controlActive' : 'controlInactive'}`) }}</span><span v-if="typeof data.available === 'boolean'" class="automation-badge">{{ t(`components.tools.automation.${data.available ? 'available' : 'unavailable'}`) }}</span></div>
          <dl class="automation-fields">
            <div v-if="data.reason"><dt>{{ t('components.tools.automation.reason') }}</dt><dd><code class="automation-code">{{ text(data.reason) }}</code></dd></div>
            <div v-if="data.stopShortcut"><dt>{{ t('components.tools.automation.stopShortcut') }}</dt><dd><kbd>{{ text(data.stopShortcut) }}</kbd><span v-if="data.stopShortcutRegistered === false" class="automation-badge is-warning">{{ t('components.tools.automation.unavailable') }}</span></dd></div>
            <div v-if="controller.actorId"><dt>{{ t('components.tools.automation.controller') }}</dt><dd>{{ text(controller.actorId) }}<div class="automation-code">{{ text(controller.runId || controller.clientId) }}</div></dd></div>
            <div v-if="strings(controller.windowIds).length"><dt>{{ toolFieldLabel('windows') }}</dt><dd class="automation-code">{{ strings(controller.windowIds).join(' · ') }}</dd></div>
          </dl>
          <p v-if="data.notice" class="automation-notice computer-notice">{{ text(data.notice) }}</p>
          <p v-if="data.pausedRunId" class="automation-notice">{{ t('components.tools.automation.userControlled') }} · <code>{{ text(data.pausedRunId) }}</code></p>
          <p v-if="data.error" class="automation-notice automation-error" role="alert">{{ text(data.error) }}</p>
        </section>

        <section v-if="Array.isArray(data.windows) || windows.length" class="automation-section computer-windows">
          <div class="automation-section-title"><h4>{{ toolFieldLabel('windows') }}</h4><span class="automation-count">{{ windows.length }}</span></div>
          <p v-if="!windows.length" class="automation-empty">{{ t('components.tools.automation.noWindows') }}</p>
          <ul v-else class="automation-list">
            <li v-for="window in windows.slice(0, visible)" :key="text(window.id)" :class="{ 'is-active': window.foreground === true }">
              <div class="automation-item-head"><strong>{{ text(window.title) || t('components.tools.automation.untitled') }}</strong><span v-if="window.foreground === true" class="automation-badge">{{ t('components.tools.automation.foreground') }}</span><span v-if="window.minimized === true" class="automation-badge is-warning">{{ t('components.tools.automation.minimized') }}</span></div>
              <div class="automation-meta"><span>{{ toolFieldLabel('windowId') }} <code>{{ text(window.id) }}</code></span><span v-if="numeric(window.processId) !== undefined">PID <code>{{ window.processId }}</code></span><span v-if="dimensions(window.bounds)">{{ dimensions(window.bounds) }} px</span><span v-if="numeric(window.dpi) !== undefined">{{ window.dpi }} DPI</span></div>
              <div v-if="window.executable || window.processName" class="automation-meta automation-code">{{ text(window.executable || window.processName) }}</div>
            </li>
          </ul>
          <button v-if="windows.length > visible" type="button" class="automation-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: windows.length - visible }) }}</button>
        </section>

        <section v-if="displays.length" class="automation-section computer-displays"><div class="automation-section-title"><h4>{{ t('components.tools.automation.displays') }}</h4><span class="automation-count">{{ displays.length }}</span></div><ul class="automation-list"><li v-for="display in displays" :key="text(display.id)"><div class="automation-item-head"><code class="automation-code">{{ text(display.id) }}</code><span v-if="display.primary === true" class="automation-badge">{{ t('components.tools.automation.primaryDisplay') }}</span></div><div class="automation-meta"><span>{{ dimensions(display.bounds) }} px</span><span v-if="numeric(display.scaleFactor) !== undefined">× {{ display.scaleFactor }}</span></div></li></ul></section>

        <VisualObservation :value="observation" />
        <p v-if="observation.notice" class="automation-notice computer-notice">{{ text(observation.notice) }}</p>
        <p v-if="observation.focusedElementId" class="automation-meta">{{ t('components.tools.automation.focusedElement') }} <code>{{ text(observation.focusedElementId) }}</code></p>
        <div v-if="observation.accessibilityError" class="automation-notice automation-error" role="alert"><strong>{{ t('components.tools.automation.accessibilityUnavailable') }}</strong><div>{{ text(observation.accessibilityError) }}</div></div>
        <section v-if="Array.isArray(observation.elements)" class="automation-section computer-elements">
          <div class="automation-section-title"><h4>{{ toolFieldLabel('elements') }}</h4><span class="automation-count">{{ elements.length }}</span></div>
          <p v-if="!elements.length" class="automation-empty">{{ t('components.tools.automation.noElements') }}</p>
          <ul v-else class="automation-list automation-content"><li v-for="(element, index) in elements.slice(0, visible)" :key="text(element.id) || index" :class="{ 'is-active': focused(element) }"><div class="automation-item-head"><span class="automation-badge">{{ text(element.type) }}</span><strong>{{ text(element.name) || text(element.automationId) || text(element.id) }}</strong><span v-if="focused(element)" class="automation-badge">{{ toolFieldLabel('focused') }}</span></div><pre v-if="element.value !== undefined && element.password !== true" class="automation-pre">{{ text(element.value) }}</pre><div class="automation-meta"><code>{{ text(element.id) }}</code><span v-if="element.enabled === false">{{ toolFieldLabel('enabled') }}: {{ t('components.tools.structured.no') }}</span><span v-if="strings(element.patterns).length">{{ strings(element.patterns).join(' · ') }}</span></div></li></ul>
          <button v-if="elements.length > visible" type="button" class="automation-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: elements.length - visible }) }}</button>
        </section>
        <p v-if="observation.truncated === true" class="automation-notice">{{ t('components.tools.automation.truncated') }}</p>
        <p v-if="!Object.keys(data).filter(key => key !== 'success').length && !error && !record(result).error" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
      </template>
    </ToolResultPanel>
  </div>
</template>

<style scoped src="./automation.css"></style>
