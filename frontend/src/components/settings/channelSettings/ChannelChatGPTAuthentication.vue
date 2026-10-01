<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue'
import type { ChatGPTAuthStatus } from '@graycode/contracts'
import { ConfirmDialog } from '../../common'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { t } from '@/i18n'

const props = defineProps<{ configId: string; prepare?: () => Promise<void> }>()
const status = ref<ChatGPTAuthStatus>({ accounts: [], storageAvailable: false, usageUrl: 'https://chatgpt.com/#settings/Usage', needsUsageNotice: false })
const busy = ref(false), error = ref(''), authorizationUrl = ref(''), callbackUrl = ref(''), notice = ref(false)
let epoch = 0, timer: ReturnType<typeof setTimeout> | undefined
const text = (key: string) => t(`desktop.chatgpt.${key}`)

function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
function schedulePoll() {
  stopPolling()
  if (['pending', 'exchanging'].includes(status.value.login?.state ?? '')) timer = setTimeout(() => { void refresh() }, 1000)
}
async function refresh(currentEpoch = epoch) {
  const configId = props.configId
  try {
    const value = await sendToExtension<ChatGPTAuthStatus>(MESSAGE_NAMES['chatgpt.status'], { configId })
    if (epoch !== currentEpoch || props.configId !== configId) return
    status.value = value
    if (value.needsUsageNotice) notice.value = true
    if (value.login?.state === 'failed') error.value = value.login.error || text('failed')
    schedulePoll()
  } catch (failure) {
    if (epoch === currentEpoch) error.value = failure instanceof Error ? failure.message : text('failed')
  }
}
async function operate(action: (configId: string) => Promise<void>, interrupt = false) {
  if (busy.value && !interrupt) return
  const configId = props.configId, currentEpoch = ++epoch
  stopPolling(); busy.value = true; error.value = ''
  try {
    await props.prepare?.()
    if (epoch !== currentEpoch || props.configId !== configId) return
    await action(configId)
    await refresh(currentEpoch)
  } catch (failure) {
    if (epoch === currentEpoch) error.value = failure instanceof Error ? failure.message : text('failed')
  } finally { if (epoch === currentEpoch) { busy.value = false; schedulePoll() } }
}
function login(newAccount = false) {
  return operate(async configId => {
    const value = await sendToExtension<{ url: string }>(MESSAGE_NAMES['chatgpt.start'], {
      configId, accountId: status.value.activeClientId, newAccount,
    })
    if (props.configId !== configId) return
    if (new URL(value.url).origin !== 'https://auth.openai.com') throw new Error(text('failed'))
    authorizationUrl.value = value.url; callbackUrl.value = ''
    window.open(value.url, '_blank', 'noopener,noreferrer')
  })
}
function select(event: Event) {
  const accountId = (event.target as HTMLSelectElement).value
  return operate(async configId => { await sendToExtension(MESSAGE_NAMES['chatgpt.select'], { configId, accountId }) })
}
function cancel() {
  return operate(async configId => {
    await sendToExtension(MESSAGE_NAMES['chatgpt.cancel'], { configId })
    authorizationUrl.value = ''; callbackUrl.value = ''
  }, true)
}
function complete() {
  return operate(async configId => {
    await sendToExtension(MESSAGE_NAMES['chatgpt.complete'], { configId, url: callbackUrl.value.trim() })
    callbackUrl.value = ''; authorizationUrl.value = ''
  })
}
function disconnect() {
  return operate(async configId => {
    const value = await sendToExtension<ChatGPTAuthStatus & { revoked: boolean }>(MESSAGE_NAMES['chatgpt.disconnect'],
      { configId, accountId: status.value.activeClientId })
    if (!value.revoked) error.value = text('revocationUnconfirmed')
    authorizationUrl.value = ''
  })
}
async function acknowledge() {
  notice.value = false
  await operate(async configId => { await sendToExtension(MESSAGE_NAMES['chatgpt.acknowledge'], { configId }) })
}
watch(() => props.configId, () => {
  epoch++; stopPolling(); authorizationUrl.value = ''; callbackUrl.value = ''; error.value = ''
  void refresh()
}, { immediate: true })
onUnmounted(() => {
  epoch++; stopPolling()
  // 只取消本界面的登录事务，不退出已经保存的账户。
  void sendToExtension(MESSAGE_NAMES['chatgpt.cancel'], { configId: props.configId }).catch(() => {})
})
</script>

<template>
  <div class="chatgpt-auth" data-search-anchor="chatgpt-authentication">
    <template v-if="status.accounts.length">
      <label>{{ text('account') }}</label>
      <select :value="status.activeClientId || ''" :disabled="busy" @change="select">
        <option v-for="account in status.accounts" :key="account.clientId" :value="account.clientId">
          {{ account.email || account.name || text('account') }} · {{ account.clientId.slice(-8) }}
        </option>
      </select>
      <p v-if="status.accounts.find(account => account.clientId === status.activeClientId)?.planEnabled" class="plan-status">
        {{ text('usingPlan') }}
      </p>
      <p v-else class="field-hint">{{ text('needsPermission') }}</p>
    </template>
    <p v-else class="field-hint">{{ status.storageAvailable ? text('notConnected') : text('storageUnavailable') }}</p>
    <div class="auth-actions">
      <button type="button" class="btn" :disabled="busy || !status.storageAvailable" @click="login()">{{ status.accounts.length ? text('reconnect') : text('connect') }}</button>
      <button v-if="status.accounts.length" type="button" class="btn" :disabled="busy || !status.storageAvailable" @click="login(true)">{{ text('addAccount') }}</button>
      <button v-if="status.accounts.find(account => account.clientId === status.activeClientId)?.connected" type="button" class="btn" :disabled="busy" @click="disconnect">{{ text('disconnect') }}</button>
      <a :href="status.usageUrl" target="_blank" rel="noopener noreferrer">{{ text('usage') }}</a>
    </div>
    <div v-if="['pending', 'exchanging'].includes(status.login?.state || '')" class="login-progress">
      <p role="status">{{ status.login?.state === 'exchanging' ? text('exchanging') : text('waiting') }}</p>
      <a v-if="authorizationUrl" :href="authorizationUrl" target="_blank" rel="noopener noreferrer">{{ text('openBrowser') }}</a>
      <label>{{ text('pasteLabel') }}</label>
      <div class="callback-input">
        <input v-model="callbackUrl" type="text" autocomplete="off" spellcheck="false" :placeholder="text('pastePlaceholder')" />
        <button type="button" class="btn" :disabled="busy || !callbackUrl.trim()" @click="complete">{{ text('complete') }}</button>
        <button type="button" class="btn" @click="cancel">{{ text('cancel') }}</button>
      </div>
    </div>
    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
    <ConfirmDialog v-model="notice" :title="text('firstUseTitle')" :message="text('firstUseMessage')"
      :confirm-text="text('understood')" :cancel-text="text('close')" @confirm="acknowledge" @cancel="acknowledge" />
  </div>
</template>

<style scoped>
.chatgpt-auth { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--gc-border-subtle); background: var(--gc-surface-input); }
.chatgpt-auth p { margin: 0; }
.chatgpt-auth select, .chatgpt-auth input { width: 100%; min-width: 0; border-radius: var(--gc-radius-sm); }
.auth-actions, .callback-input { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.callback-input input { flex: 1; min-width: 180px; }
.login-progress { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--gc-border-subtle); }
.auth-error { color: var(--gc-danger); white-space: pre-wrap; }
.plan-status { color: var(--gc-text-primary); }
.chatgpt-auth a { color: var(--gc-link); }
</style>
