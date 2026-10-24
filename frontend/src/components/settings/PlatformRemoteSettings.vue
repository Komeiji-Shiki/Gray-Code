<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppSettings, RemoteAccessSettings, RemoteAccessStatus } from '../../../../packages/contracts/src'
import { onMessageFromExtension, sendToExtension } from '../../utils/vscode'
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft'
import { copyToClipboard } from '../../utils/format'
import { randomToken, useCredentialDraft } from '../../composables/useCredentialDraft'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const credentialId = 'web_access'
const config = ref<RemoteAccessSettings>({ enabled: false, port: 0 })
const status = ref<RemoteAccessStatus>()
const accessAddress = computed(() => {
  const value = status.value
  if (!value?.address) return undefined
  // 代理入口优先展示 publicOrigin，局域网直连则展示当前网卡地址。
  return value.address !== value.localAddress ? value.address : value.lanAddress || value.address
})
const credential = useCredentialDraft(() => credentialId)
const token = credential.token
const reveal = ref(false)
const notice = ref('')
const error = ref('')
const busy = ref(false)
let ready = false
let changed = false
let refreshEpoch = 0
const date = (value: number) => new Date(value).toLocaleString()

async function refresh() {
  const epoch = ++refreshEpoch
  const result = await sendToExtension<RemoteAccessStatus>('platform.remote.status', {})
  if (epoch === refreshEpoch) status.value = result
}
function edit() { changed = true; notice.value = ''; markDesktopSettingsDirty() }
function changeToken(value: string) {
  credential.change(value)
  config.value.credentialRef = value.trim() ? credentialId : status.value?.credentialRef
  edit()
}
function generateToken() { changeToken(randomToken()) }
async function save() {
  if (!ready || !changed || status.value?.source === 'command_line') return
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  settings.remoteAccess = { ...config.value, publicOrigin: config.value.publicOrigin?.trim() || undefined }
  await sendToExtension('platform.settings.update', { settings, ...credential.updates() })
  changed = false
  credential.saved()
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await operation() } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function start() {
  await save()
  if ((await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty)
    throw new Error(t('components.settings.remoteSettings.saveAllFirst'))
  await sendToExtension('platform.remote.start', {})
  await refresh()
}
async function stop() {
  await sendToExtension('platform.remote.stop', {})
  if (status.value && ['starting', 'listening'].includes(status.value.state)) status.value.state = 'stopping'
  // 网页上的停止请求返回后即将断线，避免再向已经关闭的入口请求状态。
  notice.value = t('components.settings.remoteSettings.stopAccepted')
}
async function copy(value: string, message: string) {
  if (!await copyToClipboard(value)) throw new Error(t('components.settings.remoteSettings.copyFailed'))
  notice.value = message
}
async function revoke(id: string) {
  await sendToExtension('platform.remote.revoke', { id })
  await refresh()
}
const unsubscribe = onMessageFromExtension(message => {
  if (message.type === 'command' && message.command === 'platform.remote.changed') void refresh().catch(() => {})
})
onMounted(() => void action(async () => {
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  config.value = { ...settings.remoteAccess ?? { enabled: false, port: 0 } }
  credential.load((await sendToExtension<{ token: string }>('platform.remote.token', {})).token)
  await refresh()
  ready = true
}))
onUnmounted(() => { ++refreshEpoch; unsubscribe() })
useDesktopSettingsDraft(save, () => ready)
</script>
<template>
  <section class="remote-settings">
    <h4>{{ t('components.settings.remoteSettings.title') }}</h4>
    <p>{{ t('components.settings.remoteSettings.description') }}</p>
    <div v-if="status" class="remote-status">
      <strong :class="{ failed: status.state === 'error' }">{{ t(`components.settings.remoteSettings.states.${status.state}`) }}</strong>
      <span>{{ status.deviceName }}</span>
      <button :disabled="busy" @click="action(refresh)">{{ t('components.settings.remoteSettings.refresh') }}</button>
    </div>
    <p v-if="status?.error" role="alert" class="remote-error">{{ status.error }}</p>
    <template v-if="status?.source === 'command_line'">
      <p>{{ t('components.settings.remoteSettings.commandLine') }}</p>
    </template>
    <template v-else-if="status">
      <label class="remote-enable">
        <input v-model="config.enabled" type="checkbox" @change="edit" />
        <span>{{ t('components.settings.remoteSettings.enabled') }}</span>
      </label>
      <label class="remote-enable">
        <input v-model="config.allowLan" type="checkbox" :disabled="!!config.publicOrigin?.trim()" @change="edit" />
        <span>
          {{ t('components.settings.remoteSettings.allowLan') }}
          <small v-if="config.publicOrigin?.trim()">{{ t('components.settings.remoteSettings.allowLanProxyHint') }}</small>
          <small v-else>{{ t('components.settings.remoteSettings.allowLanHint') }}</small>
        </span>
      </label>
      <label class="remote-field">
        <span>{{ t('components.settings.remoteSettings.port') }}<small>{{ t('components.settings.remoteSettings.portHint') }}</small></span>
        <input v-model.number="config.port" type="number" min="0" max="65535" step="1" @input="edit" />
      </label>
      <label class="remote-field">
        <span>{{ t('components.settings.remoteSettings.publicOrigin') }}<small>{{ t('components.settings.remoteSettings.publicOriginHint') }}</small></span>
        <input v-model="config.publicOrigin" type="url" placeholder="https://graycode.example.com" @input="edit" />
      </label>
      <label class="remote-field">
        <span>
          {{ t('components.settings.remoteSettings.token') }}
          <small>
            {{ config.credentialRef ? t('components.settings.remoteSettings.tokenSavedHint') : t('components.settings.remoteSettings.tokenNewHint') }}
          </small>
        </span>
        <input :value="token" :type="reveal ? 'text' : 'password'" autocomplete="new-password" spellcheck="false" autocapitalize="off"
          @input="changeToken(($event.target as HTMLInputElement).value)" />
      </label>
      <div class="remote-actions">
        <button @click="generateToken">{{ t('components.settings.remoteSettings.generate') }}</button>
        <button v-if="token" @click="reveal = !reveal">
          {{ reveal ? t('components.settings.remoteSettings.hide') : t('components.settings.remoteSettings.show') }}
        </button>
        <button v-if="token" @click="action(() => copy(token.trim(), t('components.settings.remoteSettings.tokenCopied')))">
          {{ t('components.settings.remoteSettings.copyToken') }}
        </button>
      </div>
      <p>{{ t('components.settings.remoteSettings.tokenNote') }}</p>
      <p>{{ t('components.settings.remoteSettings.addressNote') }}</p>
    </template>
    <div v-if="accessAddress" class="remote-address">
      <span>{{ t('components.settings.remoteSettings.address') }}</span>
      <code>{{ accessAddress }}/</code>
      <button @click="action(() => copy(accessAddress! + '/', t('components.settings.remoteSettings.addressCopied')))">
        {{ t('components.settings.remoteSettings.copyAddress') }}
      </button>
      <small v-if="status!.address !== status!.localAddress">
        {{ t('components.settings.remoteSettings.upstream', { address: status!.localAddress ?? '' }) }}
      </small>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="status" class="remote-actions">
      <button :disabled="busy || !status.enabled || ['starting', 'stopping', 'listening'].includes(status.state)" @click="action(start)">
        {{ t('components.settings.remoteSettings.start') }}
      </button>
      <button :disabled="busy || !['starting', 'listening'].includes(status.state)" @click="action(stop)">
        {{ t('components.settings.remoteSettings.stop') }}
      </button>
    </div>
    <p v-if="status?.state === 'stopped'">{{ t('components.settings.remoteSettings.stoppedNote') }}</p>
    <h3>{{ t('components.settings.remoteSettings.devices') }}</h3>
    <p>{{ t('components.settings.remoteSettings.devicesHint') }}</p>
    <div v-for="connection in status?.connections" :key="connection.id" class="remote-connection">
      <div>
        <strong>{{ connection.name }}</strong>
        <span>
          {{ connection.connected ? t('components.settings.remoteSettings.online') : t('components.settings.remoteSettings.signedIn') }}
          · {{ t('components.settings.remoteSettings.lastSeen', { time: date(connection.lastSeenAt) }) }}
        </span>
        <small v-if="connection.expiresAt">{{ t('components.settings.remoteSettings.expires', { time: date(connection.expiresAt) }) }}</small>
      </div>
      <button v-if="connection.kind === 'browser'" :disabled="busy" @click="action(() => revoke(connection.id))">
        {{ t('components.settings.remoteSettings.revoke') }}
      </button>
      <small v-else>{{ t('components.settings.remoteSettings.apiAccessHint') }}</small>
    </div>
    <p v-if="status && !status.connections.length">{{ t('components.settings.remoteSettings.noDevices') }}</p>
    <p v-if="error" class="remote-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.remote-settings h4{font-size:24px;margin:0 0 12px}.remote-settings h3{font-size:17px;margin:30px 0 12px}.remote-settings p{color:var(--gc-text-muted);line-height:1.7;margin:12px 0 20px}.remote-settings button,.remote-settings input{font:inherit;border:1px solid var(--gc-border-control);border-radius:var(--gc-radius-sm);color:var(--gc-text-primary);background:var(--gc-surface-input);padding:8px 12px;min-width:0}.remote-settings button{cursor:pointer;white-space:nowrap}.remote-settings button:disabled{opacity:.45;cursor:default}.remote-status{display:flex;align-items:center;gap:14px;padding:16px 0;}.remote-status>span{flex:1;color:var(--gc-text-muted);overflow-wrap:anywhere}.remote-enable{display:flex;gap:12px;align-items:center;padding:20px 0}.remote-enable input{width:18px;height:18px;accent-color:var(--gc-focus-border)}.remote-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,55%);gap:24px;align-items:center;padding:17px 0;}.remote-field small{display:block;font-size:12px;color:var(--gc-text-muted);line-height:1.6;margin-top:7px}.remote-actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.remote-address{display:grid;grid-template-columns:1fr auto;gap:12px;padding:18px;border:1px solid var(--gc-border-control)}.remote-address>span,.remote-address>small{grid-column:1/-1;color:var(--gc-text-muted)}.remote-address code{align-self:center;overflow-wrap:anywhere;min-width:0}.remote-connection{display:flex;align-items:center;gap:16px;border-top:1px solid var(--gc-border-subtle);padding:16px 0}.remote-connection>div{flex:1;min-width:0}.remote-connection strong,.remote-connection span,.remote-connection small{display:block;overflow-wrap:anywhere}.remote-connection span,.remote-connection small{font-size:12px;line-height:1.7;color:var(--gc-text-muted);margin-top:5px}.remote-enable>span{flex:1;line-height:1.7}.remote-enable small{display:block;font-size:12px;color:var(--gc-text-muted);line-height:1.6;margin-top:5px}.remote-error,.failed{color:var(--gc-danger)!important}@media(max-width:600px){.remote-field{grid-template-columns:1fr;gap:10px}.remote-field input{font-size:16px;width:100%}.remote-status{gap:8px;flex-wrap:wrap}.remote-address{padding:12px}.remote-connection{gap:8px}}
</style>
