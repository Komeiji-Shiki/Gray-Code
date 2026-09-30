<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { getToolDisplayName } from '../../../utils/toolLocalization'
import { toolFieldLabel, toolLink } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import VisualActionReceipt from './VisualActionReceipt.vue'
import VisualObservation from './VisualObservation.vue'
import { actionLabel, fileSize, numeric, payload, record, records, safeAutomationResult, strings, text, type AutomationProps } from './automationResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<AutomationProps>()
const { t, actualLanguage } = useI18n()
const safeResult = computed(() => safeAutomationResult(props.result))
const data = computed(() => payload(safeResult.value))
const action = computed(() => text(props.args?.action))
const observation = computed(() => Object.keys(record(data.value.observation)).length ? record(data.value.observation) : data.value.screenshot ? data.value : {})
const page = computed(() => ({ ...observation.value, ...data.value }))
const tabs = computed(() => records(data.value.tabs ?? data.value.openedTabs))
const openedTabs = computed(() => Array.isArray(data.value.openedTabs) && !Array.isArray(data.value.tabs))
const profiles = computed(() => records(data.value.profiles))
const snapshot = computed(() => Object.keys(record(data.value.snapshot)).length ? record(data.value.snapshot) : data.value)
const nodes = computed(() => Array.isArray(snapshot.value.nodes) ? snapshot.value.nodes : [])
const frames = computed(() => records(snapshot.value.frames))
const logs = computed(() => records(data.value.entries))
const visible = ref(40)
watch(() => props.result, () => { visible.value = 40 })
const tabId = computed(() => text(data.value.tabId || (props.toolName === 'browser_tabs' || props.toolName === 'browser_action' ? data.value.id : '') || props.args?.tabId))
const profileName = (id: unknown) => text(profiles.value.find(profile => profile.id === id)?.name || id)
const fullNodeStates = (node: unknown) => Object.entries(record(node)).filter(([key]) => ['checked', 'selected', 'disabled', 'expanded', 'required', 'readonly', 'level', 'multiline'].includes(key))
function logTime(value: unknown) {
  const time = numeric(value)
  return time !== undefined && !Number.isNaN(new Date(time).getTime()) ? new Date(time).toLocaleTimeString(actualLanguage.value) : ''
}
</script>

<template>
  <div class="automation-panel browser-tool-panel">
    <ToolResultPanel :args="args" :result="safeResult" :error="error" :status="status" :tool-name="toolName">
      <div class="automation-heading"><span class="codicon codicon-globe" aria-hidden="true" /><div><div class="automation-kicker">{{ getToolDisplayName(toolName || 'browser_read') }}</div><h3>{{ actionLabel(action) }}</h3></div></div>
      <template #result>
        <VisualActionReceipt v-if="toolName === 'browser_action'" :value="data" />
        <p v-if="typeof data.conditionMet === 'boolean'" class="automation-notice" :class="{ 'automation-error': data.timedOut === true }">{{ t(`components.tools.automation.${data.conditionMet ? 'conditionMet' : 'conditionTimedOut'}`) }}</p>
        <div v-if="tabId && (toolName === 'browser_files' || !page.title && !page.url)" class="automation-meta">{{ toolFieldLabel('tabId') }} <code>{{ tabId }}</code></div>

        <template v-if="Array.isArray(data.tabs) || openedTabs">
          <div class="automation-section-title"><h4>{{ openedTabs ? t('components.tools.automation.openedTabs') : toolFieldLabel('tabs') }}</h4><span class="automation-count">{{ tabs.length }}</span></div>
          <p v-if="openedTabs" class="automation-meta">{{ t('components.tools.automation.openedTabsHint') }}</p>
          <p v-if="!tabs.length" class="automation-empty">{{ t('components.tools.automation.noTabs') }}</p>
          <ul v-else class="automation-list browser-tabs">
            <li v-for="(tab, index) in tabs.slice(0, visible)" :key="text(tab.id) || index" :class="{ 'is-active': tab.id === data.activeTabId }">
              <div class="automation-item-head"><strong>{{ text(tab.title) || t('components.tools.automation.untitled') }}</strong><span v-if="tab.id === data.activeTabId && tab.id" class="automation-badge">{{ t('components.tools.automation.activeTab') }}</span><span v-if="tab.loading === true || tab.status === 'opening'" class="automation-badge">{{ t('components.tools.automation.loading') }}</span><span v-if="tab.status === 'closed'" class="automation-badge">{{ t('components.tools.automation.closedTab') }}</span><span v-if="tab.userControlled === true" class="automation-badge is-warning">{{ t('components.tools.automation.userControlled') }}</span></div>
              <a v-if="toolLink(tab.url || tab.requestedUrl)" class="automation-link" :href="toolLink(tab.url || tab.requestedUrl)" target="_blank" rel="noopener noreferrer">{{ text(tab.url || tab.requestedUrl) }}</a><span v-else class="automation-muted">{{ text(tab.url || tab.requestedUrl) }}</span>
              <div v-if="tab.requestedUrl && tab.requestedUrl !== tab.url && tab.url" class="automation-meta">{{ t('components.tools.automation.requestedUrl') }} · {{ text(tab.requestedUrl) }}</div>
              <div class="automation-meta"><span v-if="tab.id">{{ toolFieldLabel('tabId') }} <code>{{ text(tab.id) }}</code></span><span v-if="tab.profileId">{{ toolFieldLabel('profileId') }} · {{ profileName(tab.profileId) }}</span><span v-if="record(tab.controlledBy).runId">{{ t('components.tools.automation.controlledBy') }} <code>{{ text(record(tab.controlledBy).runId) }}</code></span></div>
              <div v-if="tab.error" class="automation-notice automation-error">{{ text(tab.error) }}</div>
            </li>
          </ul>
          <button v-if="tabs.length > visible" type="button" class="automation-more" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: tabs.length - visible }) }}</button>
          <details v-if="profiles.length" class="automation-details"><summary>{{ t('components.tools.automation.profiles') }} · {{ profiles.length }}</summary><ul class="automation-list"><li v-for="profile in profiles" :key="text(profile.id)"><strong>{{ text(profile.name) }}</strong><div class="automation-meta"><code>{{ text(profile.id) }}</code></div></li></ul></details>
        </template>

        <section v-if="toolName !== 'browser_files' && (page.title || page.url)" class="automation-section current-page">
          <div class="automation-kicker">{{ t('components.tools.automation.currentPage') }}</div>
          <div class="automation-item-head"><strong>{{ text(page.title) || t('components.tools.automation.untitled') }}</strong><span v-if="page.loading === true" class="automation-badge">{{ t('components.tools.automation.loading') }}</span><span v-if="page.userControlled === true" class="automation-badge is-warning">{{ t('components.tools.automation.userControlled') }}</span></div>
          <a v-if="toolLink(page.url)" class="automation-link" :href="toolLink(page.url)" target="_blank" rel="noopener noreferrer">{{ text(page.url) }}</a><span v-else class="automation-muted">{{ text(page.url) }}</span>
          <div class="automation-meta"><span v-if="tabId">{{ toolFieldLabel('tabId') }} <code>{{ tabId }}</code></span><span v-if="page.profileId">{{ toolFieldLabel('profileId') }} <code>{{ text(page.profileId) }}</code></span><span v-if="record(page.controlledBy).runId">{{ t('components.tools.automation.controlledBy') }} <code>{{ text(record(page.controlledBy).runId) }}</code></span></div>
          <div v-if="typeof data.windowVisible === 'boolean'" class="automation-meta">{{ t('components.tools.automation.windowVisible') }} · {{ t(`components.tools.structured.${data.windowVisible ? 'yes' : 'no'}`) }}</div>
          <div v-if="page.error" class="automation-notice automation-error">{{ text(page.error) }}</div>
        </section>

        <section v-if="Array.isArray(snapshot.nodes)" class="automation-section page-snapshot">
          <div class="automation-section-title"><h4>{{ toolFieldLabel('nodes') }}</h4><span class="automation-count">{{ nodes.length }}</span></div>
          <p v-if="numeric(snapshot.total) !== undefined" class="automation-meta">{{ t('components.tools.automation.snapshotCount', { count: nodes.length, total: snapshot.total }) }}</p>
          <p v-if="!nodes.length" class="automation-empty">{{ t('components.tools.structured.empty') }}</p>
          <div v-else class="automation-content">
            <template v-for="(node, index) in nodes.slice(0, visible)" :key="index">
              <pre v-if="typeof node === 'string'" class="automation-pre">{{ node }}</pre>
              <div v-else class="snapshot-node" :style="{ paddingLeft: `${Math.min(numeric(record(node).depth) || 0, 12) * 8}px` }">
                <div class="automation-item-head"><code v-if="record(node).ref" class="automation-code">[{{ text(record(node).ref) }}]</code><span class="automation-badge">{{ text(record(node).role) }}</span><strong>{{ text(record(node).name) }}</strong></div>
                <pre v-if="record(node).value !== undefined" class="automation-pre">{{ text(record(node).value) }}</pre>
                <p v-if="record(node).description" class="automation-muted">{{ text(record(node).description) }}</p>
                <a v-if="toolLink(record(node).url)" class="automation-link" :href="toolLink(record(node).url)" target="_blank" rel="noopener noreferrer">{{ text(record(node).url) }}</a>
                <div v-if="fullNodeStates(node).length" class="automation-meta"><span v-for="[key, value] in fullNodeStates(node)" :key="key">{{ toolFieldLabel(key) }}: {{ typeof value === 'boolean' ? t(`components.tools.structured.${value ? 'yes' : 'no'}`) : text(value) }}</span></div>
              </div>
            </template>
          </div>
          <button v-if="nodes.length > visible" type="button" class="automation-more" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: nodes.length - visible }) }}</button>
          <p v-if="numeric(snapshot.nextOffset) !== undefined" class="automation-meta">{{ t('components.tools.platform.nextOffset', { offset: snapshot.nextOffset }) }}</p>
          <p v-if="snapshot.partial === true" class="automation-notice">{{ t('components.tools.platform.partial') }}</p>
          <details v-if="frames.length" class="automation-details"><summary>{{ toolFieldLabel('frames') }} · {{ frames.length }}</summary><ul class="automation-list"><li v-for="(frame, index) in frames" :key="index"><span class="automation-code">{{ text(frame.url) || text(frame.frameId) }}</span><p v-if="frame.unavailable" class="automation-notice automation-error">{{ text(frame.unavailable) }}</p></li></ul></details>
        </section>

        <section v-if="action === 'logs' && Array.isArray(data.entries)" class="automation-section page-logs">
          <div class="automation-section-title"><h4>{{ t('components.tools.automation.logs') }}</h4><span class="automation-count">{{ logs.length }}</span></div>
          <p v-if="!logs.length" class="automation-empty">{{ t('components.tools.automation.noLogs') }}</p>
          <ul v-else class="automation-list automation-content"><li v-for="(entry, index) in logs.slice(0, visible)" :key="index"><div class="automation-meta"><span class="automation-badge" :class="{ 'is-error': entry.kind === 'error' }">{{ text(entry.kind) }}</span><span>{{ logTime(entry.time) }}</span><code>#{{ text(entry.cursor) }}</code></div><pre class="automation-pre">{{ text(entry.text) }}</pre></li></ul>
          <button v-if="logs.length > visible" type="button" class="automation-more" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: logs.length - visible }) }}</button>
          <div v-if="numeric(data.nextCursor) !== undefined" class="automation-meta">{{ t('components.tools.automation.nextCursor') }} <code>{{ data.nextCursor }}</code></div>
        </section>

        <section v-if="toolName === 'browser_files' && (Array.isArray(data.files) || data.path)" class="automation-section browser-transfer">
          <div class="automation-section-title"><span class="codicon" :class="action === 'download' ? 'codicon-cloud-download' : 'codicon-cloud-upload'" aria-hidden="true" /><h4>{{ record(result).success === true ? t(`components.tools.automation.${action === 'download' ? 'downloaded' : 'uploaded'}`) : actionLabel(action) }}</h4></div>
          <ul v-if="Array.isArray(data.files)" class="automation-list"><li v-for="(file, index) in strings(data.files)" :key="index" class="automation-code">{{ file }}</li></ul>
          <strong v-if="data.filename">{{ text(data.filename) }}</strong><p v-if="data.path" class="automation-code">{{ text(data.path) }}</p>
          <a v-if="toolLink(data.url)" class="automation-link" :href="toolLink(data.url)" target="_blank" rel="noopener noreferrer">{{ text(data.url) }}</a>
          <div class="automation-meta"><span v-if="numeric(data.count) !== undefined">{{ toolFieldLabel('count') }} · {{ data.count }}</span><span v-if="fileSize(data.bytes)">{{ t('components.tools.automation.size') }} · {{ fileSize(data.bytes) }}</span></div>
        </section>
        <VisualObservation :value="observation" />
        <p v-if="data.truncated === true || snapshot.truncated === true" class="automation-notice">{{ t('components.tools.automation.truncated') }}</p>
        <p v-if="!Object.keys(data).filter(key => key !== 'success').length && !error && !record(result).error" class="automation-empty">{{ t(record(result).success === true ? 'components.tools.structured.noOutput' : 'components.tools.structured.empty') }}</p>
      </template>
    </ToolResultPanel>
  </div>
</template>

<style scoped src="./automation.css"></style>
<style scoped>.snapshot-node{padding-top:6px;padding-bottom:6px;border-bottom:1px solid var(--gc-border-subtle)}</style>
