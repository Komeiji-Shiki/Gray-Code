<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AppSettings, SpeechProvider, SpeechSettings, SpeechStatus } from '../../../../packages/contracts/src'
import { sendToExtension } from '../../utils/vscode'
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft'
import { speak } from '../../composables/useSpeechPlayback'
import { DEFAULT_SPEECH_SETTINGS, SPEECH_PROVIDER_DEFAULTS } from '@shared/speech'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const isDesktopHost = typeof window !== 'undefined' && !!window.__GRAYCODE_HOST
const saving = ref(false)
const config = ref<SpeechSettings>({ ...DEFAULT_SPEECH_SETTINGS })
const status = ref<SpeechStatus>()
const token = ref('')
const reveal = ref(false)
const notice = ref('')
const error = ref('')
const busy = ref(false)
const cloneTitle = ref('')
const cloneText = ref('')
const cloneFile = ref<File>()
const cloning = ref(false)
let ready = false
let changed = false
let tokenEdited = false
const isRemoteProvider = computed(() => config.value.provider !== 'system')
const credentialId = computed(() => `speech_${config.value.provider}_key`)
const providers: { value: SpeechProvider; label: string }[] = [
  { value: 'fish', label: t('components.settings.speechSettings.providers.fish') },
  { value: 'openai', label: t('components.settings.speechSettings.providers.openai') },
  { value: 'qwen', label: t('components.settings.speechSettings.providers.qwen') },
  { value: 'system', label: t('components.settings.speechSettings.providers.system') },
]

function edit() { changed = true; notice.value = ''; markDesktopSettingsDirty() }

async function refreshStatus() {
  status.value = await sendToExtension<SpeechStatus>('speech.status', {})
}

async function loadCredential(provider: SpeechProvider) {
  if (provider === 'system') return ''
  return (await sendToExtension<{ token: string }>('speech.credential', { provider })).token
}

async function changeProvider(provider: SpeechProvider) {
  if (config.value.provider === provider) return
  // 音色不跨提供商沿用：OpenAI 的 alloy 对 Windows 语音或 Qwen 都无效。
  const defaults = SPEECH_PROVIDER_DEFAULTS[provider]
  config.value = { ...config.value, ...defaults, voice: defaults.voice, provider }
  token.value = await loadCredential(provider)
  tokenEdited = false
  config.value.credentialRef = token.value.trim() ? credentialId.value : undefined
  if (provider === 'system' && status.value?.systemVoices?.length) config.value.voice = status.value.systemVoices[0]
  edit()
}

function changeToken(value: string) {
  token.value = value
  tokenEdited = true
  config.value.credentialRef = value.trim() ? credentialId.value : undefined
  edit()
}

async function save() {
  if (!ready || !changed) return
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  settings.speech = { ...config.value, endpoint: config.value.endpoint?.trim() || undefined,
    credentialRef: isRemoteProvider.value ? config.value.credentialRef : undefined }
  await sendToExtension('platform.settings.update', { settings, ...(tokenEdited ? {
    credentials: token.value.trim() ? { [credentialId.value]: token.value.trim() } : {},
    clearCredentialChanges: token.value.trim() ? [] : [credentialId.value],
  } : {}) })
  changed = false
  tokenEdited = false
  await refreshStatus()
}

/** 网页宿主没有桌面底部“保存全部”，在这里显式提交整份设置。 */
async function persist() {
  if (saving.value) return
  saving.value = true; error.value = ''
  try {
    await save()
    await sendToExtension('ui.settings.save', {})
    notice.value = t('components.settings.speechSettings.saved')
  } catch (cause) { error.value = (cause as Error).message }
  finally { saving.value = false }
}

async function test() {
  if (changed) { error.value = t('components.settings.speechSettings.saveFirst'); return }
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await speak(t('components.settings.speechSettings.testText')) }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}

function readAudio(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/, ''))
    reader.onerror = () => reject(new Error(t('components.settings.speechSettings.clone.readFailed')))
    reader.readAsDataURL(file)
  })
}

function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  cloneFile.value = file
  if (file && !cloneTitle.value) cloneTitle.value = file.name.replace(/\.[^.]+$/, '')
}

async function createVoice() {
  if (changed) { error.value = t('components.settings.speechSettings.saveFirst'); return }
  if (!cloneFile.value) { error.value = t('components.settings.speechSettings.clone.chooseFile'); return }
  if (cloning.value) return
  cloning.value = true; error.value = ''; notice.value = ''
  try {
    const audio = await readAudio(cloneFile.value)
    const result = await sendToExtension<{ id: string; state?: string }>('speech.clone', {
      title: cloneTitle.value.trim() || t('components.settings.speechSettings.clone.defaultTitle'),
      audio, mimeType: cloneFile.value.type || 'audio/wav',
      ...(cloneText.value.trim() ? { text: cloneText.value.trim() } : {}),
    })
    config.value.referenceId = result.id
    edit()
    notice.value = t('components.settings.speechSettings.clone.created', { id: result.id, state: result.state || '-' })
  } catch (cause) { error.value = (cause as Error).message }
  finally { cloning.value = false }
}

onMounted(async () => {
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {})
  config.value = { ...DEFAULT_SPEECH_SETTINGS, ...settings.speech }
  token.value = await loadCredential(config.value.provider)
  if (token.value.trim() && isRemoteProvider.value && !config.value.credentialRef) config.value.credentialRef = credentialId.value
  await refreshStatus()
  if (config.value.provider === 'system' && !config.value.voice && status.value?.systemVoices?.length)
    config.value.voice = status.value.systemVoices[0]
  ready = true
})
useDesktopSettingsDraft(save, () => ready)
</script>

<template>
  <section class="speech-settings">
    <h4>{{ t('components.settings.speechSettings.title') }}</h4>
    <p>{{ t('components.settings.speechSettings.description') }}</p>
    <label class="speech-enable">
      <input v-model="config.enabled" type="checkbox" @change="edit" />
      <span>
        {{ t('components.settings.speechSettings.enabled') }}
        <small>{{ t('components.settings.speechSettings.enabledHint') }}</small>
      </span>
    </label>
    <label class="speech-enable">
      <input v-model="config.autoPlay" type="checkbox" @change="edit" />
      <span>
        {{ t('components.settings.speechSettings.autoPlay') }}
        <small>{{ t('components.settings.speechSettings.autoPlayHint') }}</small>
      </span>
    </label>

    <div class="speech-section" data-search-anchor="speech-provider">
      <h5>{{ t('components.settings.speechSettings.providerTitle') }}</h5>
      <label class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.provider') }}
          <small>{{ t('components.settings.speechSettings.providerHint') }}</small>
        </span>
        <select :value="config.provider" @change="changeProvider(($event.target as HTMLSelectElement).value as SpeechProvider)">
          <option v-for="item in providers" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <label v-if="isRemoteProvider" class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.apiKey') }}
          <small>{{ t('components.settings.speechSettings.apiKeyHint') }}</small>
        </span>
        <div class="speech-secret">
          <input :value="token" :type="reveal ? 'text' : 'password'" autocomplete="new-password" spellcheck="false"
            @input="changeToken(($event.target as HTMLInputElement).value)" />
          <button type="button" @click="reveal = !reveal">
            {{ reveal ? t('components.settings.speechSettings.hide') : t('components.settings.speechSettings.show') }}
          </button>
        </div>
      </label>
      <label v-if="isRemoteProvider" class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.endpoint') }}
          <small>{{ t('components.settings.speechSettings.endpointHint') }}</small>
        </span>
        <input v-model="config.endpoint" type="url" spellcheck="false" @input="edit" />
      </label>
      <label v-if="config.provider !== 'fish' && isRemoteProvider" class="speech-field">
        <span>{{ t('components.settings.speechSettings.model') }}</span>
        <input v-model="config.model" spellcheck="false" @input="edit" />
      </label>
      <label v-if="config.provider === 'fish'" class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.model') }}
          <small>{{ t('components.settings.speechSettings.fishModelHint') }}</small>
        </span>
        <input v-model="config.model" spellcheck="false" @input="edit" />
      </label>
      <label v-if="config.provider !== 'fish' && config.provider !== 'system'" class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.voice') }}
          <small>{{ t('components.settings.speechSettings.voiceHint') }}</small>
        </span>
        <input v-model="config.voice" spellcheck="false" @input="edit" />
      </label>
      <label v-if="config.provider === 'system'" class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.systemVoice') }}
          <small>{{ status?.error || t('components.settings.speechSettings.systemVoiceHint') }}</small>
        </span>
        <select v-model="config.voice" @change="edit">
          <option value="">{{ t('components.settings.speechSettings.systemDefault') }}</option>
          <option v-for="voice in status?.systemVoices ?? []" :key="voice" :value="voice">{{ voice }}</option>
        </select>
      </label>
      <label v-if="config.provider !== 'system'" class="speech-field">
        <span>{{ t('components.settings.speechSettings.format') }}</span>
        <select v-model="config.format" @change="edit">
          <option value="mp3">MP3</option>
          <option value="wav">WAV</option>
          <option v-if="config.provider !== 'qwen'" value="opus">Opus</option>
        </select>
      </label>
      <label class="speech-field">
        <span>{{ t('components.settings.speechSettings.speed') }}<small>{{ config.speed ?? 1 }}×</small></span>
        <input v-model.number="config.speed" type="range" min="0.5" max="2" step="0.05" @input="edit" />
      </label>
    </div>

    <div v-if="config.provider === 'fish'" class="speech-section" data-search-anchor="speech-clone">
      <h5>{{ t('components.settings.speechSettings.clone.title') }}</h5>
      <p class="speech-hint">{{ t('components.settings.speechSettings.clone.description') }}</p>
      <label class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.clone.voiceId') }}
          <small>{{ t('components.settings.speechSettings.clone.voiceIdHint') }}</small>
        </span>
        <input v-model="config.referenceId" spellcheck="false" @input="edit" />
      </label>
      <label class="speech-field">
        <span>{{ t('components.settings.speechSettings.clone.name') }}</span>
        <input v-model="cloneTitle" :placeholder="t('components.settings.speechSettings.clone.namePlaceholder')" />
      </label>
      <label class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.clone.file') }}
          <small>{{ t('components.settings.speechSettings.clone.fileHint') }}</small>
        </span>
        <input type="file" accept="audio/*" @change="chooseFile" />
      </label>
      <label class="speech-field">
        <span>
          {{ t('components.settings.speechSettings.clone.referenceText') }}
          <small>{{ t('components.settings.speechSettings.clone.referenceTextHint') }}</small>
        </span>
        <input v-model="cloneText" />
      </label>
      <div class="speech-actions">
        <button type="button" :disabled="cloning" @click="createVoice">
          {{ cloning ? t('components.settings.speechSettings.clone.creating') : t('components.settings.speechSettings.clone.create') }}
        </button>
        <small>{{ t('components.settings.speechSettings.clone.saveFirstHint') }}</small>
      </div>
    </div>

    <p class="speech-hint">{{ t('components.settings.speechSettings.autoTagHint') }}</p>
    <div class="speech-actions">
      <button v-if="!isDesktopHost" type="button" :disabled="saving" @click="persist">
        {{ saving ? t('components.settings.speechSettings.saving') : t('components.settings.speechSettings.saveSettings') }}
      </button>
      <button type="button" :disabled="busy || !config.enabled" @click="test">
        {{ busy ? t('components.settings.speechSettings.testing') : t('components.settings.speechSettings.test') }}
      </button>
      <small v-if="status">
        {{ status.provider }} · {{ status.enabled ? t('components.settings.speechSettings.statusEnabled') : t('components.settings.speechSettings.statusDisabled') }}
      </small>
    </div>
    <p v-if="notice" role="status" class="speech-notice">{{ notice }}</p>
    <p v-if="error" role="alert" class="speech-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.speech-settings h4 {
  font-size: 24px;
  margin: 0 0 12px;
}
.speech-settings h5 {
  font-size: 16px;
  margin: 0 0 12px;
}
.speech-settings p {
  color: var(--gc-text-muted);
  line-height: 1.7;
  margin: 12px 0 20px;
}
.speech-enable {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 0;
}
.speech-enable input {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  accent-color: var(--gc-focus-border);
}
.speech-enable > span {
  flex: 1;
  line-height: 1.7;
}
.speech-enable small,
.speech-field small {
  display: block;
  font-size: 12px;
  color: var(--gc-text-muted);
  line-height: 1.6;
  margin-top: 5px;
}
.speech-section {
  border-top: 1px solid var(--gc-border-subtle);
  padding: 20px 0 6px;
  margin-top: 8px;
}
.speech-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 55%);
  gap: 24px;
  align-items: center;
  padding: 12px 0;
}
.speech-field > span {
  line-height: 1.6;
}
.speech-settings input,
.speech-settings select,
.speech-settings button {
  font: inherit;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  color: var(--gc-text-primary);
  background: var(--gc-surface-input);
  padding: 8px 12px;
  min-width: 0;
}
.speech-settings input[type="checkbox"],
.speech-settings input[type="range"] {
  padding: 0;
  border: 0;
  background: transparent;
}
.speech-settings button {
  cursor: pointer;
  white-space: nowrap;
}
.speech-settings button:disabled {
  opacity: 0.45;
  cursor: default;
}
.speech-secret {
  display: flex;
  gap: 8px;
  min-width: 0;
}
.speech-secret input {
  flex: 1;
  min-width: 0;
}
.speech-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 16px 0;
}
.speech-actions small {
  color: var(--gc-text-muted);
  line-height: 1.6;
}
.speech-hint {
  font-size: 12px !important;
  margin: 10px 0 !important;
}
.speech-notice {
  color: var(--gc-success) !important;
}
.speech-error {
  color: var(--gc-danger) !important;
}
@media (max-width: 640px) {
  .speech-field {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .speech-field input,
  .speech-field select {
    font-size: 16px;
    width: 100%;
  }
}
</style>
