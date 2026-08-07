<script setup lang="ts">
/**
 * SandboxSettings - 沙箱设置面板
 *
 * 功能：
 * 1. 启用/禁用沙箱工具（总开关）
 * 2. 配置允许运行的语言白名单
 * 3. 配置默认超时时间、最大输出行数、临时目录清理
 */

import { ref, reactive, onMounted } from 'vue'
import { CustomCheckbox, LoadingSpinner } from '../common'
import { t } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'

interface SandboxConfig {
  enabled: boolean
  allowedLanguages: string[]
  defaultTimeout: number
  maxOutputLines: number
  cleanupTempDir: boolean
}

const ALL_LANGUAGES = ['python', 'javascript', 'bash', 'powershell', 'sh']

const isLoading = ref(false)
const isSaving = ref(false)
const loadError = ref('')
const saveMessage = ref('')
const saveError = ref('')

const config = reactive<SandboxConfig>({
  enabled: false,
  allowedLanguages: [...ALL_LANGUAGES],
  defaultTimeout: 30000,
  maxOutputLines: 200,
  cleanupTempDir: true
})

// 草稿：用户编辑中的值，点击保存才提交
const draft = reactive<SandboxConfig>({
  enabled: false,
  allowedLanguages: [...ALL_LANGUAGES],
  defaultTimeout: 30000,
  maxOutputLines: 200,
  cleanupTempDir: true
})

async function loadConfig() {
  isLoading.value = true
  loadError.value = ''
  try {
    const response = await sendToExtension<SandboxConfig>('getSandboxConfig', {})
    if (response) {
      config.enabled = response.enabled !== false
      config.allowedLanguages = Array.isArray(response.allowedLanguages) && response.allowedLanguages.length > 0
        ? [...response.allowedLanguages]
        : [...ALL_LANGUAGES]
      config.defaultTimeout = typeof response.defaultTimeout === 'number' ? response.defaultTimeout : 30000
      config.maxOutputLines = typeof response.maxOutputLines === 'number' ? response.maxOutputLines : 200
      config.cleanupTempDir = response.cleanupTempDir !== false
      syncDraft()
    }
  } catch (error: any) {
    loadError.value = error?.message || 'Failed to load sandbox config'
  } finally {
    isLoading.value = false
  }
}

function syncDraft() {
  draft.enabled = config.enabled
  draft.allowedLanguages = [...config.allowedLanguages]
  draft.defaultTimeout = config.defaultTimeout
  draft.maxOutputLines = config.maxOutputLines
  draft.cleanupTempDir = config.cleanupTempDir
}

/** 总开关：立即保存 */
async function toggleEnabled(val: boolean) {
  const prev = config.enabled
  config.enabled = val
  draft.enabled = val
  try {
    await sendToExtension('updateSandboxConfig', { config: { enabled: val } })
    saveMessage.value = t('components.settings.sandbox.saved')
    saveError.value = ''
    setTimeout(() => { saveMessage.value = '' }, 2000)
  } catch (error: any) {
    config.enabled = prev
    draft.enabled = prev
    saveError.value = error?.message || t('components.settings.sandbox.saveFailed')
  }
}

function isLanguageAllowed(lang: string): boolean {
  return draft.allowedLanguages.includes(lang)
}

function toggleLanguage(lang: string, checked: boolean) {
  if (checked) {
    if (!draft.allowedLanguages.includes(lang)) {
      draft.allowedLanguages.push(lang)
    }
  } else {
    draft.allowedLanguages = draft.allowedLanguages.filter(l => l !== lang)
  }
}

async function saveConfig() {
  isSaving.value = true
  saveMessage.value = ''
  saveError.value = ''
  try {
    const payload: Partial<SandboxConfig> = {
      allowedLanguages: [...draft.allowedLanguages],
      defaultTimeout: draft.defaultTimeout,
      maxOutputLines: draft.maxOutputLines,
      cleanupTempDir: draft.cleanupTempDir
    }
    await sendToExtension('updateSandboxConfig', { config: payload })
    config.allowedLanguages = [...draft.allowedLanguages]
    config.defaultTimeout = draft.defaultTimeout
    config.maxOutputLines = draft.maxOutputLines
    config.cleanupTempDir = draft.cleanupTempDir
    saveMessage.value = t('components.settings.sandbox.saved')
    setTimeout(() => { saveMessage.value = '' }, 2000)
  } catch (error: any) {
    saveError.value = error?.message || t('components.settings.sandbox.saveFailed')
  } finally {
    isSaving.value = false
  }
}

function resetDefaults() {
  draft.allowedLanguages = [...ALL_LANGUAGES]
  draft.defaultTimeout = 30000
  draft.maxOutputLines = 200
  draft.cleanupTempDir = true
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="sandbox-settings">
    <LoadingSpinner v-if="isLoading" />

    <div v-else>
      <p v-if="loadError" class="error-hint">{{ loadError }}</p>

      <!-- 总开关 -->
      <div class="section sandbox-toggle-section" data-search-anchor="sandbox-toggle">
        <div class="section-header">
          <CustomCheckbox
            :modelValue="config.enabled"
            :label="t('components.settings.sandbox.enabled.label')"
            @update:modelValue="(v: boolean) => toggleEnabled(v)"
          />
        </div>
        <p class="field-description">{{ t('components.settings.sandbox.enabled.description') }}</p>
        <p v-if="!config.enabled" class="disabled-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.sandbox.enabled.disabledNotice') }}
        </p>
      </div>

      <div class="divider"></div>

      <!-- 配置区域：总开关关闭时置灰 -->
      <div :class="{ 'settings-disabled': !config.enabled }">
        <!-- 允许的语言 -->
        <div class="section" data-search-anchor="sandbox-languages">
          <label class="group-label">
            <i class="codicon codicon-code"></i>
            {{ t('components.settings.sandbox.languages.title') }}
          </label>
          <p class="field-description">{{ t('components.settings.sandbox.languages.description') }}</p>

          <div class="language-grid">
            <div
              v-for="lang in ALL_LANGUAGES"
              :key="lang"
              class="language-item"
            >
              <CustomCheckbox
                :modelValue="isLanguageAllowed(lang)"
                :disabled="!config.enabled"
                :label="lang"
                @update:modelValue="(v: boolean) => toggleLanguage(lang, v)"
              />
            </div>
          </div>
        </div>

        <div class="divider"></div>

        <!-- 超时时间 -->
        <div class="section" data-search-anchor="sandbox-timeout">
          <label class="group-label">
            <i class="codicon codicon-clock"></i>
            {{ t('components.settings.sandbox.timeout.title') }}
          </label>
          <p class="field-description">{{ t('components.settings.sandbox.timeout.description') }}</p>

          <div class="number-input-row">
            <input
              type="number"
              v-model.number="draft.defaultTimeout"
              min="1000"
              max="600000"
              step="1000"
              :disabled="!config.enabled"
              class="number-input"
            />
            <span class="unit">ms</span>
          </div>
        </div>

        <div class="divider"></div>

        <!-- 最大输出行数 -->
        <div class="section" data-search-anchor="sandbox-output">
          <label class="group-label">
            <i class="codicon codicon-output"></i>
            {{ t('components.settings.sandbox.output.title') }}
          </label>
          <p class="field-description">{{ t('components.settings.sandbox.output.description') }}</p>

          <div class="number-input-row">
            <input
              type="number"
              v-model.number="draft.maxOutputLines"
              min="-1"
              max="100000"
              step="10"
              :disabled="!config.enabled"
              class="number-input"
            />
            <span class="unit">{{ t('components.settings.sandbox.output.unit') }}</span>
          </div>
          <p class="field-hint">{{ t('components.settings.sandbox.output.hint') }}</p>
        </div>

        <div class="divider"></div>

        <!-- 清理临时目录 -->
        <div class="section" data-search-anchor="sandbox-cleanup">
          <label class="group-label">
            <i class="codicon codicon-trash"></i>
            {{ t('components.settings.sandbox.cleanup.title') }}
          </label>
          <p class="field-description">{{ t('components.settings.sandbox.cleanup.description') }}</p>

          <CustomCheckbox
            v-model="draft.cleanupTempDir"
            :disabled="!config.enabled"
            :label="t('components.settings.sandbox.cleanup.label')"
          />
        </div>

        <div class="divider"></div>

        <!-- 安全提示 -->
        <div class="section info-section" data-search-anchor="sandbox-info">
          <label class="group-label">
            <i class="codicon codicon-shield"></i>
            {{ t('components.settings.sandbox.info.title') }}
          </label>
          <p class="field-description">{{ t('components.settings.sandbox.info.text') }}</p>
        </div>

        <!-- 保存按钮 -->
        <div class="save-bar">
          <button
            class="save-btn"
            @click="saveConfig"
            :disabled="isSaving || !config.enabled"
          >
            <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ t('components.settings.sandbox.save') }}</span>
          </button>
          <button
            class="reset-btn"
            @click="resetDefaults"
            :disabled="isSaving || !config.enabled"
          >
            {{ t('components.settings.sandbox.reset') }}
          </button>
          <span v-if="saveMessage" class="save-message success">{{ saveMessage }}</span>
          <span v-else-if="saveError" class="save-message error">{{ saveError }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sandbox-settings {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section {
  margin-bottom: 8px;
}

.section-header {
  margin-bottom: 4px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}

.field-description {
  font-size: 12px;
  opacity: 0.7;
  margin: 0 0 8px 0;
  line-height: 1.5;
}

.field-hint {
  font-size: 11px;
  opacity: 0.6;
  margin: 4px 0 0 0;
}

.disabled-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.7;
  margin: 8px 0 0 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background, rgba(255, 255, 255, 0.04));
}

.settings-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.divider {
  height: 1px;
  background: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
  margin: 10px 0;
}

.language-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.language-item {
  display: flex;
  align-items: center;
}

.number-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.number-input {
  width: 120px;
  padding: 4px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  font-size: 13px;
}

.number-input:disabled {
  opacity: 0.6;
}

.unit {
  font-size: 12px;
  opacity: 0.7;
}

.info-section {
  padding: 10px 12px;
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background, rgba(255, 255, 255, 0.04));
}

.save-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.save-btn,
.reset-btn {
  padding: 5px 14px;
  border-radius: 2px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--vscode-button-border, transparent);
}

.save-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.save-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.reset-btn {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, inherit);
}

.reset-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.1));
}

.save-btn:disabled,
.reset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-message {
  font-size: 12px;
}

.save-message.success {
  color: var(--vscode-testing-iconPassed, #4ec9b0);
}

.save-message.error {
  color: var(--vscode-testing-iconFailed, #f48771);
}

.error-hint {
  color: var(--vscode-testing-iconFailed, #f48771);
  font-size: 12px;
}
</style>
