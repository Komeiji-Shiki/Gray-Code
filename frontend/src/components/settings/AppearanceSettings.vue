<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useSettingsStore } from '@/stores'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const isLoading = ref(true)
const isSaving = ref(false)
const saveMessage = ref('')
const saveMessageType = ref<'success' | 'error'>('success')

// 为空表示使用默认值（通常来自 i18n）
const loadingText = ref<string>('')
const selectionContextEnabled = ref(true)

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
    const response = await sendToExtension<any>('getSettings', {})
    const appearance = response?.settings?.ui?.appearance
    const saved = appearance?.loadingText ?? ''
    const savedSelectionContextEnabled = resolveSelectionContextEnabled(appearance)

    loadingText.value = saved
    selectionContextEnabled.value = savedSelectionContextEnabled
    settingsStore.setAppearanceLoadingText(saved)
    settingsStore.setSelectionContextEnabled(savedSelectionContextEnabled)
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

    await sendToExtension('updateUISettings', {
      ui: {
        appearance: {
          // 空字符串表示使用默认值
          loadingText: normalized,
          selectionContextEnabled: selectionContextEnabled.value
        }
      }
    })

    // 同步到前端状态，确保立即生效
    settingsStore.setAppearanceLoadingText(normalized)
    settingsStore.setSelectionContextEnabled(selectionContextEnabled.value)

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
      <div class="form-group">
        <label class="group-label">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          {{ t('components.settings.appearanceSettings.loadingText.title') }}
        </label>
        <p class="field-description">{{ t('components.settings.appearanceSettings.loadingText.description') }}</p>

        <input
          v-model="loadingText"
          type="text"
          class="text-input"
          :placeholder="t('components.settings.appearanceSettings.loadingText.placeholder')"
        />
        <p class="field-hint">{{ t('components.settings.appearanceSettings.loadingText.defaultHint', { text: defaultLoadingText }) }}</p>
      </div>

      <div class="form-group">
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

          <label class="toggle-switch">
            <input
              v-model="selectionContextEnabled"
              type="checkbox"
              :disabled="isSaving"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="actions">
        <button class="action-btn primary" @click="saveConfig" :disabled="isSaving">
          <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-else>{{ t('common.save') }}</span>
        </button>

        <button class="action-btn" @click="resetToDefault" :disabled="isSaving">
          <i class="codicon codicon-discard"></i>
          {{ t('common.reset') }}
        </button>

        <span v-if="saveMessage" class="save-message" :class="saveMessageType">
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
  gap: 16px;
}

.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
  padding: 16px 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toggle-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.group-label .codicon {
  font-size: 14px;
}

.field-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.text-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.text-input:focus {
  border-color: var(--vscode-focusBorder);
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background-color: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 10px;
  transition: 0.2s;
}

.toggle-slider::before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: var(--vscode-foreground);
  border-radius: 50%;
  transition: 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background-color: var(--vscode-button-foreground);
}

.toggle-switch input:focus + .toggle-slider {
  border-color: var(--vscode-focusBorder);
}

.toggle-switch input:disabled + .toggle-slider {
  opacity: 0.6;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
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
  font-size: 12px;
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
