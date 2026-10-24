<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppSettings, ControlApiSettings, ControlApiStatus } from '../../../../packages/contracts/src'
import { onMessageFromExtension, sendToExtension } from '../../utils/vscode'
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft'
import { copyToClipboard } from '../../utils/format'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const credentialId = 'control_api_token'
const config = ref<ControlApiSettings>({ enabled: false, port: 18766, allowLan: false })
const status = ref<ControlApiStatus>()
const token = ref('')
const reveal = ref(false)
const notice = ref('')
const error = ref('')
const busy = ref(false)
let ready = false
let changed = false
let tokenEdited = false
const stateLabels = computed<Record<ControlApiStatus['state'], string>>(() => ({
  disabled: t('components.settings.controlApiSettings.states.disabled'),
  stopped: t('components.settings.controlApiSettings.states.stopped'),
  starting: t('components.settings.controlApiSettings.states.starting'),
  listening: t('components.settings.controlApiSettings.states.listening'),
  stopping: t('components.settings.controlApiSettings.states.stopping'),
  error: t('components.settings.controlApiSettings.states.error'),
}))
const address = computed(() => status.value?.localAddress ?? `http://127.0.0.1:${config.value.port || '<port>'}`)

async function refresh() {
  status.value = await sendToExtension<ControlApiStatus>('platform.controlApi.status', {})
}
function edit() { changed = true; notice.value = ''; markDesktopSettingsDirty() }
function changeToken(value: string) {
  token.value = value
  tokenEdited = true
  config.value.credentialRef = value.trim() ? credentialId : undefined
  edit()
}
function generateToken() {
  changeToken([...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join(''))
}
async function save() {
  if (!ready || !changed) return
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  settings.controlApi = { ...config.value }
  await sendToExtension('platform.settings.update', { settings, ...(tokenEdited ? {
    credentials: token.value.trim() ? { [credentialId]: token.value.trim() } : {},
    clearCredentialChanges: token.value.trim() ? [] : [credentialId],
  } : {}) })
  changed = false
  tokenEdited = false
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await operation() } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function start() {
  await action(async () => {
    await save()
    if ((await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) throw new Error(t('components.settings.controlApiSettings.saveAllFirst'))
    await sendToExtension('platform.controlApi.start', {})
    await refresh()
  })
}
async function stop() {
  await action(async () => {
    await sendToExtension('platform.controlApi.stop', {})
    if (status.value && ['starting', 'listening'].includes(status.value.state)) status.value.state = 'stopping'
    notice.value = t('components.settings.controlApiSettings.stopAccepted')
  })
}
async function copy(value: string, message: string) {
  if (!await copyToClipboard(value)) throw new Error(t('components.settings.controlApiSettings.copyFailed'))
  notice.value = message
}
const example = computed(() => `curl -H "Authorization: Bearer ${token.value || '<token>'}" "${address.value}/v1"`)
const unsubscribe = onMessageFromExtension(message => {
  if (message.type === 'command' && message.command === 'platform.controlApi.changed') void refresh().catch(() => {})
})
onUnmounted(unsubscribe)
onMounted(() => void action(async () => {
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  config.value = { ...config.value, ...settings.controlApi }
  token.value = (await sendToExtension<{ token: string }>('platform.controlApi.token', {})).token
  await refresh()
  ready = true
}))
useDesktopSettingsDraft(save, () => ready)
</script>

<template>
  <section class="control-settings">
    <h4>{{ t('components.settings.controlApiSettings.title') }}</h4>
    <p>{{ t('components.settings.controlApiSettings.description') }}</p>
    <div v-if="status" class="control-status">
      <strong :class="{ failed: status.state === 'error' }">{{ stateLabels[status.state] }}</strong>
      <span v-if="status.port">{{ address }}</span>
      <button type="button" :disabled="busy" @click="action(refresh)">
        {{ t('components.settings.controlApiSettings.refresh') }}
      </button>
    </div>
    <p v-if="status?.error" role="alert" class="control-error">{{ status.error }}</p>
    <label class="control-enable">
      <input v-model="config.enabled" type="checkbox" @change="edit" />
      <span>
        {{ t('components.settings.controlApiSettings.enabled') }}
        <small>{{ t('components.settings.controlApiSettings.enabledHint') }}</small>
      </span>
    </label>
    <label class="control-enable">
      <input v-model="config.allowLan" type="checkbox" @change="edit" />
      <span>
        {{ t('components.settings.controlApiSettings.allowLan') }}
        <small>{{ t('components.settings.controlApiSettings.allowLanHint') }}</small>
      </span>
    </label>
    <label class="control-field">
      <span>
        {{ t('components.settings.controlApiSettings.port') }}
        <small>{{ t('components.settings.controlApiSettings.portHint') }}</small>
      </span>
      <input v-model.number="config.port" type="number" min="0" max="65535" step="1" @input="edit" />
    </label>
    <label class="control-field" data-search-anchor="control-api-token">
      <span>
        {{ t('components.settings.controlApiSettings.token') }}
        <small>{{ t('components.settings.controlApiSettings.tokenHint') }}</small>
      </span>
      <input :value="token" :type="reveal ? 'text' : 'password'" autocomplete="new-password" spellcheck="false"
        autocapitalize="off" @input="changeToken(($event.target as HTMLInputElement).value)" />
    </label>
    <div class="control-actions">
      <button type="button" @click="generateToken">{{ t('components.settings.controlApiSettings.generate') }}</button>
      <button v-if="token" type="button" @click="reveal = !reveal">
        {{ reveal ? t('components.settings.controlApiSettings.hide') : t('components.settings.controlApiSettings.show') }}
      </button>
      <button v-if="token" type="button"
        @click="action(() => copy(token.trim(), t('components.settings.controlApiSettings.tokenCopied')))">
        {{ t('components.settings.controlApiSettings.copyToken') }}
      </button>
    </div>
    <div class="control-actions">
      <button type="button"
        :disabled="busy || !status?.enabled || ['starting', 'stopping', 'listening'].includes(status?.state ?? '')"
        @click="start">
        {{ t('components.settings.controlApiSettings.start') }}
      </button>
      <button type="button" :disabled="busy || !['starting', 'listening'].includes(status?.state ?? '')" @click="stop">
        {{ t('components.settings.controlApiSettings.stop') }}
      </button>
    </div>
    <div class="control-address">
      <span>{{ t('components.settings.controlApiSettings.address') }}</span>
      <code>{{ address }}</code>
      <button type="button"
        @click="action(() => copy(address, t('components.settings.controlApiSettings.addressCopied')))">
        {{ t('components.settings.controlApiSettings.copyAddress') }}
      </button>
      <small v-if="status?.lanAddress">
        {{ t('components.settings.controlApiSettings.lanAddress') }}：{{ status.lanAddress }}
      </small>
    </div>
    <h3>{{ t('components.settings.controlApiSettings.endpoints') }}</h3>
    <p>{{ t('components.settings.controlApiSettings.endpointsHint') }}</p>
    <ul class="control-endpoints">
      <li><code>GET /v1</code><span>{{ t('components.settings.controlApiSettings.endpointCatalog') }}</span></li>
      <li><code>GET /v1/status</code><span>{{ t('components.settings.controlApiSettings.endpointStatus') }}</span></li>
      <li><code>GET /v1/conversations</code><span>{{ t('components.settings.controlApiSettings.endpointConversations') }}</span></li>
      <li><code>POST /v1/conversations/:id/messages</code><span>{{ t('components.settings.controlApiSettings.endpointMessages') }}</span></li>
      <li><code>GET /v1/events</code><span>{{ t('components.settings.controlApiSettings.endpointEvents') }}</span></li>
      <li><code>POST /v1/rpc</code><span>{{ t('components.settings.controlApiSettings.endpointRpc') }}</span></li>
      <li><code>POST /v1/speech</code><span>{{ t('components.settings.controlApiSettings.endpointSpeech') }}</span></li>
    </ul>
    <pre class="control-example">{{ example }}</pre>
    <p class="control-hint">{{ t('components.settings.controlApiSettings.agentHint') }}</p>
    <p class="control-hint">{{ t('components.settings.controlApiSettings.securityHint') }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert" class="control-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.control-settings h4 {
  font-size: 24px;
  margin: 0 0 12px;
}
.control-settings h3 {
  font-size: 16px;
  margin: 28px 0 10px;
}
.control-settings p {
  color: var(--gc-text-muted);
  line-height: 1.7;
  margin: 12px 0 18px;
}
.control-status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 0;
}
.control-status > span {
  flex: 1;
  color: var(--gc-text-muted);
  overflow-wrap: anywhere;
}
.control-status .failed {
  color: var(--gc-danger);
}
.control-enable {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 0;
}
.control-enable input {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  accent-color: var(--gc-focus-border);
}
.control-enable > span {
  flex: 1;
  line-height: 1.7;
}
.control-enable small,
.control-field small {
  display: block;
  font-size: 12px;
  color: var(--gc-text-muted);
  line-height: 1.6;
  margin-top: 5px;
}
.control-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 55%);
  gap: 24px;
  align-items: center;
  padding: 12px 0;
}
.control-settings input,
.control-settings button {
  font: inherit;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  color: var(--gc-text-primary);
  background: var(--gc-surface-input);
  padding: 8px 12px;
  min-width: 0;
}
.control-settings button {
  cursor: pointer;
  white-space: nowrap;
}
.control-settings button:disabled {
  opacity: 0.45;
  cursor: default;
}
.control-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0;
}
.control-address {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--gc-border-control);
}
.control-address > span,
.control-address > small {
  grid-column: 1 / -1;
  color: var(--gc-text-muted);
}
.control-address code {
  overflow-wrap: anywhere;
  min-width: 0;
  align-self: center;
}
.control-endpoints {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0 0 14px;
  list-style: none;
}
.control-endpoints li {
  display: grid;
  grid-template-columns: minmax(0, auto) 1fr;
  gap: 14px;
  align-items: baseline;
  color: var(--gc-text-muted);
  line-height: 1.6;
}
.control-endpoints code {
  color: var(--gc-text-primary);
  overflow-wrap: anywhere;
}
.control-example {
  padding: 14px;
  border: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-raised);
  color: var(--gc-text-secondary);
  font-size: 12px;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.control-hint {
  font-size: 12px !important;
}
.control-error {
  color: var(--gc-danger) !important;
}
@media (max-width: 640px) {
  .control-field {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .control-field input {
    font-size: 16px;
    width: 100%;
  }
  .control-endpoints li {
    grid-template-columns: 1fr;
  }
}
</style>
