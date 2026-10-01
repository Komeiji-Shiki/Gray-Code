<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from 'vue'
import type { ChatGPTAuthStatus } from '@graycode/contracts'
import { ConfirmDialog, CustomSelect } from '../../common'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { t } from '@/i18n'

const props = defineProps<{ configId: string; prepare?: () => Promise<void> }>()
const status = ref<ChatGPTAuthStatus>({ accounts: [], storageAvailable: false, usageUrl: 'https://chatgpt.com/#settings/Usage', needsUsageNotice: false })
const busy = ref(false), error = ref(''), authorizationUrl = ref(''), callbackUrl = ref(''), notice = ref(false)
let epoch = 0, timer: ReturnType<typeof setTimeout> | undefined
const text = (key: string) => t(`desktop.chatgpt.${key}`)
const activeAccount = computed(() => status.value.accounts.find(account => account.clientId === status.value.activeClientId))
const accountOptions = computed(() => status.value.accounts.map(account => ({
  value: account.clientId,
  label: account.email || account.name || text('account'),
  description: account.clientId.slice(-8),
})))

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
function select(accountId: string) {
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
  <div class="chatgpt-auth" data-search-anchor="chatgpt-authentication" :aria-busy="busy">
    <div class="auth-header">
      <span class="auth-mark" aria-hidden="true"><i class="codicon codicon-account"></i></span>
      <div class="auth-heading">
        <h3 class="auth-title">
          {{ text('account') }}
          <span v-if="activeAccount" class="auth-account-id" :title="activeAccount.clientId">{{ activeAccount.clientId.slice(-8) }}</span>
        </h3>
        <p class="auth-status" :class="{ 'is-connected': activeAccount?.planEnabled }" role="status">
          <i v-if="activeAccount?.planEnabled" class="codicon codicon-verified" aria-hidden="true"></i>
          <span v-if="status.accounts.length">{{ activeAccount?.planEnabled ? text('usingPlan') : text('needsPermission') }}</span>
          <span v-else>{{ status.storageAvailable ? text('notConnected') : text('storageUnavailable') }}</span>
        </p>
      </div>
      <a class="gc-button gc-button--ghost usage-link" :href="status.usageUrl" target="_blank" rel="noopener noreferrer">
        {{ text('usage') }}<i class="codicon codicon-link-external" aria-hidden="true"></i>
      </a>
    </div>
    <CustomSelect v-if="status.accounts.length" :model-value="status.activeClientId || ''"
      :options="accountOptions" :aria-label="text('account')" :disabled="busy" @update:model-value="select" />
    <div class="auth-actions">
      <button type="button" class="gc-button" :class="{ 'gc-button--primary': !activeAccount?.planEnabled }"
        :disabled="busy || !status.storageAvailable" @click="login()">
        <i class="codicon" :class="status.accounts.length ? 'codicon-refresh' : 'codicon-sign-in'" aria-hidden="true"></i>
        {{ status.accounts.length ? text('reconnect') : text('connect') }}
      </button>
      <button v-if="status.accounts.length" type="button" class="gc-button gc-button--ghost"
        :disabled="busy || !status.storageAvailable" @click="login(true)">
        <i class="codicon codicon-add" aria-hidden="true"></i>{{ text('addAccount') }}
      </button>
      <button v-if="activeAccount?.connected" type="button" class="gc-button gc-button--ghost auth-disconnect" :disabled="busy" @click="disconnect">
        <i class="codicon codicon-sign-out" aria-hidden="true"></i>{{ text('disconnect') }}
      </button>
    </div>
    <div v-if="['pending', 'exchanging'].includes(status.login?.state || '')" class="login-progress">
      <div class="login-heading">
        <p class="login-status" role="status">
          <i class="codicon codicon-browser" aria-hidden="true"></i>
          {{ status.login?.state === 'exchanging' ? text('exchanging') : text('waiting') }}
        </p>
        <a v-if="authorizationUrl" class="gc-link-button" :href="authorizationUrl" target="_blank" rel="noopener noreferrer">
          {{ text('openBrowser') }}<i class="codicon codicon-link-external" aria-hidden="true"></i>
        </a>
      </div>
      <label class="callback-label" :for="`chatgpt-callback-${configId}`">{{ text('pasteLabel') }}</label>
      <div class="callback-input">
        <input :id="`chatgpt-callback-${configId}`" v-model="callbackUrl" class="gc-field" type="text" autocomplete="off" spellcheck="false" :placeholder="text('pastePlaceholder')" />
        <button type="button" class="gc-button gc-button--primary" :disabled="busy || !callbackUrl.trim()" @click="complete">{{ text('complete') }}</button>
        <button type="button" class="gc-button gc-button--ghost" @click="cancel">{{ text('cancel') }}</button>
      </div>
    </div>
    <div v-if="error" class="auth-error" role="alert">
      <i class="codicon codicon-error" aria-hidden="true"></i><p>{{ error }}</p>
    </div>
    <ConfirmDialog v-model="notice" :title="text('firstUseTitle')" :message="text('firstUseMessage')"
      :confirm-text="text('understood')" :cancel-text="text('close')" @confirm="acknowledge" @cancel="acknowledge" />
  </div>
</template>

<style scoped>
.chatgpt-auth {
  display: grid;
  gap: var(--gc-space-4);
  min-width: 0;
  padding: var(--gc-space-4);
  color: var(--gc-text-primary);
  background: var(--gc-surface-raised);
  border: 1px solid var(--gc-border-subtle);
  line-height: var(--gc-line-height-normal);
}

.chatgpt-auth p { margin: 0; }
.auth-header { display: flex; align-items: flex-start; gap: var(--gc-space-3); flex-wrap: wrap; }
.auth-mark {
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  height: 36px;
  color: var(--gc-accent);
  background: var(--gc-info-bg);
}
.auth-mark .codicon { font-size: var(--gc-icon-size-lg); }
.auth-heading { flex: 1; min-width: 160px; }
.auth-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gc-space-2);
  margin: 0 0 var(--gc-space-1);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-semibold);
  line-height: var(--gc-line-height-tight);
}
.auth-account-id {
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  font-size: var(--gc-font-size-caption);
  font-weight: var(--gc-font-weight-regular);
}
.auth-status {
  display: flex;
  align-items: flex-start;
  gap: var(--gc-space-1);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
  overflow-wrap: anywhere;
}
.auth-status .codicon { margin-top: 2px; font-size: var(--gc-icon-size-sm); }
.auth-status.is-connected .codicon { color: var(--gc-success); }
.usage-link { flex-shrink: 0; margin-left: auto; text-decoration: none; }
.auth-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--gc-space-2); }
.auth-actions .gc-button, .callback-input .gc-button { min-height: var(--gc-control-height-lg); white-space: nowrap; cursor: pointer; }
.chatgpt-auth .gc-button:disabled { cursor: default; }
.auth-disconnect { margin-left: auto; }
.auth-disconnect:hover:not(:disabled) { color: var(--gc-danger); background: var(--gc-danger-bg); }
.login-progress {
  display: grid;
  gap: var(--gc-space-3);
  padding: var(--gc-space-3);
  background: var(--gc-surface-muted);
}
.login-heading { display: flex; align-items: center; flex-wrap: wrap; gap: var(--gc-space-2) var(--gc-space-3); }
.login-status { display: flex; align-items: flex-start; gap: var(--gc-space-2); font-size: var(--gc-font-size-body); }
.login-status .codicon { color: var(--gc-accent); margin-top: 2px; }
.login-heading .gc-link-button { margin-left: auto; gap: var(--gc-space-1); font-size: var(--gc-font-size-body); }
.callback-label { color: var(--gc-text-muted); font-size: var(--gc-font-size-body); }
.callback-input { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--gc-space-2); }
.callback-input input { min-width: 0; }
.auth-error {
  display: flex;
  align-items: flex-start;
  gap: var(--gc-space-2);
  padding: var(--gc-space-3);
  color: var(--gc-danger);
  background: var(--gc-danger-bg);
  font-size: var(--gc-font-size-body);
}
.auth-error .codicon { flex-shrink: 0; margin-top: 2px; }
.auth-error p { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }

@media (max-width: 480px) {
  .usage-link { margin-left: calc(36px + var(--gc-space-3)); }
  .auth-disconnect { margin-left: 0; }
  .callback-input input { grid-column: 1 / -1; }
}
</style>
