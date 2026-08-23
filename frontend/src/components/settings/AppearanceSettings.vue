<script setup lang="ts">
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useSettingsStore } from '@/stores'
import type { SmoothMode } from '@/utils/smoothStream'
import { CustomSwitch } from '@/components/common'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const SMOOTH_STREAMING_MODES: SmoothMode[] = ['off', 'smooth', 'balanced', 'silky']

function isSmoothMode(value: unknown): value is SmoothMode {
  return SMOOTH_STREAMING_MODES.includes(value as SmoothMode)
}

const isLoading = ref(true)
const isSaving = ref(false)
const saveMessage = ref('')
const saveMessageType = ref<'success' | 'error'>('success')

// 为空表示使用默认值（通常来自 i18n）
const loadingText = ref<string>('')
const selectionContextEnabled = ref(true)
const smoothStreamingMode = ref<SmoothMode>('balanced')
const tpsBarEnabled = ref(true)
const splashEnabled = ref(true)

const defaultLoadingText = computed(() => t('common.loading'))

function resolveSelectionContextEnabled(appearance: any): boolean {
  if (!appearance) return true
  if (typeof appearance.selectionContextEnabled === 'boolean') {
    return appearance.selectionContextEnabled
  }

  const hasLegacy =
    typeof appearance.selectionContextHoverEnabled === 'boolean' ||
    typeof appearance.selectionContextCodeActionEnabled === 'boolean'

  if (!hasLegacy) return true

  return (appearance.selectionContextHoverEnabled ?? true) ||
    (appearance.selectionContextCodeActionEnabled ?? true)
}

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getSettings, {})
    const appearance = response?.settings?.ui?.appearance
    const saved = appearance?.loadingText ?? ''
    const savedSelectionContextEnabled = resolveSelectionContextEnabled(appearance)

    loadingText.value = saved
    selectionContextEnabled.value = savedSelectionContextEnabled
    const savedSmoothStreaming = isSmoothMode(appearance?.smoothStreaming) ? appearance.smoothStreaming : 'balanced'
    smoothStreamingMode.value = savedSmoothStreaming
    tpsBarEnabled.value = appearance?.tpsBarEnabled !== false
    splashEnabled.value = appearance?.splashEnabled !== false
    settingsStore.setAppearanceLoadingText(saved)
    settingsStore.setSelectionContextEnabled(savedSelectionContextEnabled)
    settingsStore.setSmoothStreaming(savedSmoothStreaming)
    settingsStore.setTpsBarEnabled(tpsBarEnabled.value)
    settingsStore.setSplashEnabled(splashEnabled.value)
  } catch (error) {
    console.error('Failed to load appearance settings:', error)
  } finally {
    isLoading.value = false
  }
}

async function saveConfig() {
  isSaving.value = true
  saveMessage.value = ''

  try {
    const normalized = loadingText.value.trim()

    await sendToExtension(MESSAGE_NAMES.updateUISettings, {
      ui: {
        appearance: {
          // 空字符串表示使用默认值
          loadingText: normalized,
          selectionContextEnabled: selectionContextEnabled.value,
          smoothStreaming: smoothStreamingMode.value,
          tpsBarEnabled: tpsBarEnabled.value,
          splashEnabled: splashEnabled.value
        }
      }
    })

    // 同步到前端状态，确保立即生效
    settingsStore.setAppearanceLoadingText(normalized)
    settingsStore.setSelectionContextEnabled(selectionContextEnabled.value)
    settingsStore.setSmoothStreaming(smoothStreamingMode.value)
    settingsStore.setTpsBarEnabled(tpsBarEnabled.value)
    settingsStore.setSplashEnabled(splashEnabled.value)

    saveMessage.value = t('components.settings.appearanceSettings.saveSuccess')
    saveMessageType.value = 'success'

    setTimeout(() => {
      saveMessage.value = ''
    }, 2000)
  } catch (error) {
    console.error('Failed to save appearance settings:', error)
    saveMessage.value = t('components.settings.appearanceSettings.saveFailed')
    saveMessageType.value = 'error'
  } finally {
    isSaving.value = false
  }
}

async function resetToDefault() {
  loadingText.value = ''
  selectionContextEnabled.value = true
  smoothStreamingMode.value = 'balanced'
  tpsBarEnabled.value = true
  splashEnabled.value = true
  await saveConfig()
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="appearance-settings">
    <div v-if="isLoading" class="loading">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('common.loading') }}</span>
    </div>

    <template v-else>
      <div class="form-group" data-search-anchor="loading-text">
        <label class="group-label" for="appearance-loading-text">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          {{ t('components.settings.appearanceSettings.loadingText.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.appearanceSettings.loadingText.description') }}</p>

        <input
          id="appearance-loading-text"
          v-model="loadingText"
          type="text"
          class="text-input gc-field"
          :placeholder="t('components.settings.appearanceSettings.loadingText.placeholder')"
        />
        <p class="field-hint">{{ t('components.settings.appearanceSettings.loadingText.defaultHint', { text: defaultLoadingText }) }}</p>
      </div>

      <div class="form-group" data-search-anchor="smooth-output">
        <label class="group-label" for="appearance-smooth-output">
          <i class="codicon codicon-type"></i>
          {{ t('components.settings.appearanceSettings.smoothStreaming.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.appearanceSettings.smoothStreaming.description') }}</p>

        <select id="appearance-smooth-output" v-model="smoothStreamingMode" class="text-input select-input gc-field" :disabled="isSaving">
          <option value="off">{{ t('components.settings.appearanceSettings.smoothStreaming.off') }}</option>
          <option value="smooth">{{ t('components.settings.appearanceSettings.smoothStreaming.smooth') }}</option>
          <option value="balanced">{{ t('components.settings.appearanceSettings.smoothStreaming.balanced') }}</option>
          <option value="silky">{{ t('components.settings.appearanceSettings.smoothStreaming.silky') }}</option>
        </select>
      </div>

      <div class="form-group" data-search-anchor="selection-entry">
        <div class="toggle-row">
          <div class="toggle-content">
            <label class="group-label">
              <i class="codicon codicon-link-external"></i>
              {{ t('components.settings.appearanceSettings.selectionContext.title') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.appearanceSettings.selectionContext.description') }}
            </p>
          </div>

          <CustomSwitch
            v-model="selectionContextEnabled"
            :aria-label="t('components.settings.appearanceSettings.selectionContext.title')"
            :disabled="isSaving"
          />
        </div>
      </div>

      <div class="form-group" data-search-anchor="tps-bar">
        <div class="toggle-row">
          <div class="toggle-content">
            <label class="group-label">
              <i class="codicon codicon-pulse"></i>
              {{ t('components.settings.appearanceSettings.tpsBar.title') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.appearanceSettings.tpsBar.description') }}
            </p>
          </div>

          <CustomSwitch
            v-model="tpsBarEnabled"
            :aria-label="t('components.settings.appearanceSettings.tpsBar.title')"
            :disabled="isSaving"
          />
        </div>
      </div>

      <div class="form-group" data-search-anchor="splash-animation">
        <div class="toggle-row">
          <div class="toggle-content">
            <label class="group-label">
              <i class="codicon codicon-play"></i>
              {{ t('components.settings.appearanceSettings.splash.title') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.appearanceSettings.splash.description') }}
            </p>
          </div>

          <CustomSwitch
            v-model="splashEnabled"
            :aria-label="t('components.settings.appearanceSettings.splash.title')"
            :disabled="isSaving"
          />
        </div>
      </div>

      <div class="actions">
        <button type="button" class="action-btn primary gc-button gc-button--primary" @click="saveConfig" :disabled="isSaving">
          <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-else>{{ t('common.save') }}</span>
        </button>

        <button type="button" class="action-btn gc-button" @click="resetToDefault" :disabled="isSaving">
          <i class="codicon codicon-discard"></i>
          {{ t('common.reset') }}
        </button>

        <span v-if="saveMessage" class="save-message" :class="saveMessageType" role="status" aria-live="polite">
          {{ saveMessage }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.appearance-settings {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-4);
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  color: var(--gc-text-muted);
  padding: var(--gc-space-4) 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
  padding: var(--gc-space-3);
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-md);
}

.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gc-space-4);
}

.toggle-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
}

.group-label {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  font-size: var(--gc-font-size-control);
  font-weight: var(--gc-font-weight-medium);
}

.group-label .codicon {
  font-size: 14px;
}

.field-description {
  margin: 0;
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-muted);
}

.text-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--gc-radius-sm);
  transition: border-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.text-input:focus {
  border-color: var(--gc-focus-border);
}

.select-input {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--vscode-foreground) 50%),
    linear-gradient(135deg, var(--vscode-foreground) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  cursor: pointer;
}

.field-hint {
  margin: 0;
  font-size: var(--gc-font-size-caption);
  color: var(--gc-text-muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: var(--gc-font-size-body);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.save-message {
  font-size: var(--gc-font-size-body);
}

.save-message.success {
  color: var(--vscode-terminal-ansiGreen);
}

.save-message.error {
  color: var(--vscode-errorForeground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
