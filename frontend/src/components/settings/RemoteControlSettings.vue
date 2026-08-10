<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { CustomCheckbox } from '../common'

const { t } = useI18n()

interface RemoteControlStatusPayload {
  available: boolean
  enabled: boolean
  port: number
  running: boolean
  error?: string
  urls?: string[]
  activeConversationId?: string | null
}

const DEFAULT_PORT = 17532

const isLoading = ref(true)
const isSaving = ref(false)
const saveMessage = ref('')
const saveMessageType = ref<'success' | 'error'>('success')

const enabled = ref(false)
const portInput = ref(String(DEFAULT_PORT))
const status = ref<RemoteControlStatusPayload>({
  available: false,
  enabled: false,
  port: DEFAULT_PORT,
  running: false
})
const copiedUrl = ref('')

const portError = computed(() => {
  const value = portInput.value.trim()
  if (!value) return t('components.settings.settingsPanel.remoteControlSettings.port.required')
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return t('components.settings.settingsPanel.remoteControlSettings.port.invalid')
  }
  return ''
})

const hasChanges = computed(() => {
  const n = Number(portInput.value.trim())
  const portOk = Number.isInteger(n) && n >= 1 && n <= 65535
  return portOk && (enabled.value !== status.value.enabled || n !== status.value.port)
})

async function loadStatus(preserveDraft = false) {
  isLoading.value = true
  try {
    const response = await sendToExtension<RemoteControlStatusPayload>('remoteControl.getStatus', {})
    if (response) {
      status.value = {
        available: response.available !== false,
        enabled: response.enabled === true,
        port: Number.isInteger(response.port) && (response.port as number) > 0 ? response.port : DEFAULT_PORT,
        running: response.running === true,
        error: response.error || undefined,
        urls: Array.isArray(response.urls) ? response.urls : undefined,
        activeConversationId: response.activeConversationId ?? null
      }
      // preserveDraft（重试按钮等场景）：不回写开关/端口，避免覆盖未保存的编辑
      if (!preserveDraft) {
        enabled.value = status.value.enabled
        portInput.value = String(status.value.port)
      }
    }
  } catch (error) {
    console.error('Failed to load remote control status:', error)
  } finally {
    isLoading.value = false
  }
}

async function saveSettings() {
  if (portError.value || !hasChanges.value) return
  isSaving.value = true
  saveMessage.value = ''
  try {
    await sendToExtension('updateRemoteControlSettings', {
      remoteControlSettings: {
        enabled: enabled.value,
        port: Number(portInput.value.trim())
      }
    })
    saveMessage.value = t('components.settings.settingsPanel.remoteControlSettings.saveSuccess')
    saveMessageType.value = 'success'
    // 保存后刷新服务器状态（开关/端口已由主进程应用）
    await loadStatus()
    // 覆盖 loadStatus 回读的旧值提示语，避免闪烁
    saveMessage.value = t('components.settings.settingsPanel.remoteControlSettings.saveSuccess')
    setTimeout(() => { saveMessage.value = '' }, 3000)
  } catch (error: any) {
    console.error('Failed to save remote control settings:', error)
    saveMessage.value = error?.message || t('components.settings.settingsPanel.remoteControlSettings.saveFailed')
    saveMessageType.value = 'error'
    setTimeout(() => { saveMessage.value = '' }, 5000)
  } finally {
    isSaving.value = false
  }
}

async function retryServer() {
  try {
    await sendToExtension('remoteControl.apply', { type: 'restart' })
    // 只刷新服务器状态，不回读 enabled/port（避免覆盖用户正在编辑的表单草稿）
    await loadStatus(true)
  } catch (error) {
    console.error('Failed to restart remote control server:', error)
  }
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    copiedUrl.value = url
    setTimeout(() => { copiedUrl.value = '' }, 2000)
  } catch {
    // 剪贴板不可用时不做处理
  }
}

onMounted(loadStatus)
</script>

<template>
  <div class="remote-control-settings">
    <p v-if="!status.available" class="desktop-only-hint">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.remoteControlSettings.desktopOnly') }}
    </p>

    <template v-else>
      <!-- 总开关 -->
      <div class="form-group" data-search-anchor="remote-control-enable">
        <label class="group-label">
          <i class="codicon codicon-remote"></i>
          {{ t('components.settings.settingsPanel.remoteControlSettings.enabled.label') }}
        </label>
        <p class="field-description">{{ t('components.settings.settingsPanel.remoteControlSettings.enabled.description') }}</p>
        <div class="rc-enable">
          <CustomCheckbox
            v-model="enabled"
            :label="t('components.settings.settingsPanel.remoteControlSettings.enabled.label')"
          />
          <span class="rc-state" :class="{ running: status.running }">
            <i class="codicon" :class="status.running ? 'codicon-circle-filled' : 'codicon-circle-outline'"></i>
            {{ status.running
              ? t('components.settings.settingsPanel.remoteControlSettings.status.running')
              : t('components.settings.settingsPanel.remoteControlSettings.status.stopped') }}
          </span>
        </div>
        <p v-if="status.error" class="error-hint">
          <i class="codicon codicon-error"></i>
          {{ status.error }}
          <button class="link-btn" @click="retryServer">
            {{ t('components.settings.settingsPanel.remoteControlSettings.status.retry') }}
          </button>
        </p>
      </div>

      <div class="divider"></div>

      <!-- 端口设置 -->
      <div class="form-group" data-search-anchor="remote-control-port">
        <label class="group-label">
          <i class="codicon codicon-ports"></i>
          {{ t('components.settings.settingsPanel.remoteControlSettings.port.label') }}
        </label>
        <p class="field-description">{{ t('components.settings.settingsPanel.remoteControlSettings.port.description') }}</p>
        <div class="rc-port-row">
          <input
            v-model="portInput"
            type="number"
            min="1"
            max="65535"
            class="rc-port-input"
            :class="{ invalid: !!portError }"
            @input="saveMessage = ''"
          />
          <button
            class="save-btn"
            :disabled="isSaving || !!portError || !hasChanges"
            @click="saveSettings"
          >
            <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ t('components.settings.settingsPanel.remoteControlSettings.save') }}</span>
          </button>
          <span v-if="saveMessage" class="save-message" :class="saveMessageType">
            {{ saveMessage }}
          </span>
        </div>
        <p v-if="portError" class="error-hint">{{ portError }}</p>
      </div>

      <div class="divider"></div>

      <!-- 访问地址 -->
      <div class="form-group" data-search-anchor="remote-control-urls">
        <label class="group-label">
          <i class="codicon codicon-globe"></i>
          {{ t('components.settings.settingsPanel.remoteControlSettings.urls.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.settingsPanel.remoteControlSettings.urls.description') }}</p>
        <div v-if="status.running && status.urls && status.urls.length > 0" class="rc-url-list">
          <div v-for="url in status.urls" :key="url" class="rc-url-item">
            <span class="rc-url-text">{{ url }}</span>
            <button class="icon-btn-mini" :title="t('components.settings.settingsPanel.remoteControlSettings.urls.copy')" @click="copyUrl(url)">
              <i class="codicon" :class="copiedUrl === url ? 'codicon-check' : 'codicon-copy'"></i>
            </button>
          </div>
        </div>
        <p v-else class="field-description muted">
          {{ t('components.settings.settingsPanel.remoteControlSettings.urls.empty') }}
        </p>
      </div>

      <div class="divider"></div>

      <!-- 安全提示 -->
      <div class="form-group" data-search-anchor="remote-control-info">
        <label class="group-label">
          <i class="codicon codicon-shield"></i>
          {{ t('components.settings.settingsPanel.remoteControlSettings.info.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.settingsPanel.remoteControlSettings.info.text') }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.remote-control-settings {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.desktop-only-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border: 1px dashed var(--vscode-editorWidget-border, #555);
  border-radius: 8px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 13px;
}

.rc-enable {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.rc-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.rc-state.running {
  color: var(--vscode-charts-green, #4ec9b0);
}

.rc-state .codicon-circle-filled {
  font-size: 10px;
}

.rc-port-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.rc-port-input {
  width: 130px;
  padding: 6px 10px;
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 6px;
  background: var(--vscode-input-background, #2d2d2f);
  color: var(--vscode-input-foreground, #d4d4d4);
  font-size: 13.5px;
  outline: none;
}

.rc-port-input:focus {
  border-color: var(--vscode-focusBorder, #4da3ff);
}

.rc-port-input.invalid {
  border-color: var(--vscode-errorForeground, #f14c4c);
}

.rc-url-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.rc-url-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
  border-radius: 8px;
  background: var(--vscode-editor-background, #1e1e1e);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  word-break: break-all;
}

.rc-url-text {
  flex: 1;
  min-width: 0;
}

.icon-btn-mini {
  flex: none;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.icon-btn-mini:hover {
  color: var(--vscode-foreground, #d4d4d4);
  background: var(--vscode-toolbar-hoverBackground, #2d2d2f);
}

.error-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-errorForeground, #f14c4c);
  font-size: 12.5px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--vscode-textLink-foreground, #4da3ff);
  cursor: pointer;
  font-size: 12.5px;
  padding: 0;
  text-decoration: underline;
}

.muted {
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
</style>
