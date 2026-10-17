<script setup lang="ts">
/**
 * 网页搜索工具设置面板
 *
 * 配置 DeepSeek Search API 的接口地址、凭据与默认结果参数。
 * 搜索凭据独立于模型渠道，允许渠道走第三方中转时继续使用官方搜索。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { CustomCheckbox } from '../../../common'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'

interface WebSearchConfig {
  endpoint: string
  apiKey: string
  count: number
  needContent: boolean
}

const DEFAULT_CONFIG: WebSearchConfig = {
  endpoint: 'https://api.deepseek.com/v1/tools/search',
  apiKey: '',
  count: 10,
  needContent: false
}

const config = reactive<WebSearchConfig>({ ...DEFAULT_CONFIG })
const showApiKey = ref(false)
const isLoading = ref(false)
const isSaving = ref(false)

let saveTimer: ReturnType<typeof setTimeout> | null = null

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ config: Partial<WebSearchConfig> }>(MESSAGE_NAMES['tools.getToolConfig'], {
      toolName: 'web_search'
    })
    if (response?.config) {
      config.endpoint = response.config.endpoint ?? DEFAULT_CONFIG.endpoint
      config.apiKey = response.config.apiKey ?? DEFAULT_CONFIG.apiKey
      config.count = response.config.count ?? DEFAULT_CONFIG.count
      config.needContent = response.config.needContent ?? DEFAULT_CONFIG.needContent
    }
  } catch (error) {
    console.error('Failed to load web_search config:', error)
  } finally {
    isLoading.value = false
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persistConfig()
  }, 400)
}

async function persistConfig() {
  isSaving.value = true
  try {
    await sendToExtension(MESSAGE_NAMES['tools.updateToolConfig'], {
      toolName: 'web_search',
      config: {
        endpoint: config.endpoint.trim(),
        apiKey: config.apiKey.trim(),
        count: clampCount(config.count),
        needContent: config.needContent
      }
    })
  } catch (error) {
    console.error('Failed to save web_search config:', error)
  } finally {
    isSaving.value = false
  }
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.count
  return Math.min(50, Math.max(1, Math.trunc(value)))
}

function cancelSaveTimer() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

useDesktopSettingsDraft(async () => {
  cancelSaveTimer()
  await persistConfig()
}, () => true, cancelSaveTimer)

onMounted(loadConfig)
onUnmounted(cancelSaveTimer)
</script>

<template>
  <div class="web-search-config">
    <div class="config-section">
      <div class="section-header">
        <i class="codicon codicon-globe"></i>
        <span>{{ t('components.settings.toolSettings.web.webSearch.title') }}</span>
      </div>

      <div v-if="isLoading" class="loading-state">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.settings.toolSettings.common.loading') }}</span>
      </div>

      <div v-else class="config-options">
        <label class="field">
          <span class="field-label">{{ t('components.settings.toolSettings.web.webSearch.endpoint') }}</span>
          <input
            v-model="config.endpoint"
            type="text"
            spellcheck="false"
            :placeholder="DEFAULT_CONFIG.endpoint"
            @input="scheduleSave"
          />
          <span class="field-hint">{{ t('components.settings.toolSettings.web.webSearch.endpointHint') }}</span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('components.settings.toolSettings.web.webSearch.apiKey') }}</span>
          <div class="secret-input">
            <input
              v-model="config.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('components.settings.toolSettings.web.webSearch.apiKeyPlaceholder')"
              @input="scheduleSave"
            />
            <button
              type="button"
              class="reveal-button"
              :title="showApiKey ? t('components.settings.toolSettings.web.webSearch.hideKey') : t('components.settings.toolSettings.web.webSearch.showKey')"
              @click="showApiKey = !showApiKey"
            >
              <i :class="['codicon', showApiKey ? 'codicon-eye-closed' : 'codicon-eye']"></i>
            </button>
          </div>
        </label>

        <label class="field field-inline">
          <span class="field-label">{{ t('components.settings.toolSettings.web.webSearch.count') }}</span>
          <input
            v-model.number="config.count"
            class="count-input"
            type="number"
            min="1"
            max="50"
            @input="scheduleSave"
          />
        </label>

        <div class="field-inline">
          <CustomCheckbox v-model="config.needContent" :disabled="isSaving" @update:modelValue="scheduleSave" />
          <div class="checkbox-copy">
            <span class="field-label">{{ t('components.settings.toolSettings.web.webSearch.needContent') }}</span>
            <span class="field-hint">{{ t('components.settings.toolSettings.web.webSearch.needContentHint') }}</span>
          </div>
        </div>

        <div class="tool-description">
          <i class="codicon codicon-info"></i>
          <span>{{ t('components.settings.toolSettings.web.webSearch.description') }}</span>
        </div>
      </div>

      <div v-if="isSaving" class="save-status">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.settings.toolSettings.common.saving') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.web-search-config {
  padding: 12px;
  background: var(--gc-surface-muted);
  border-radius: var(--gc-radius-sm);
  margin-top: 8px;
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--gc-text-primary);
}

.section-header .codicon {
  font-size: 14px;
  color: var(--gc-chart-blue);
}

.loading-state,
.save-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--gc-text-muted);
}

.config-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-inline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.field-label {
  font-size: 12px;
  color: var(--gc-text-primary);
}

.field-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--gc-text-muted);
}

.field input {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--gc-text-primary);
  background: var(--gc-surface-default);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  outline: none;
}

.field input:focus {
  border-color: var(--gc-accent);
}

.secret-input {
  display: flex;
  align-items: center;
  gap: 4px;
}

.secret-input input {
  flex: 1;
  min-width: 0;
}

.reveal-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--gc-text-muted);
  background: transparent;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  cursor: pointer;
}

.reveal-button:hover {
  color: var(--gc-text-primary);
}

.count-input {
  width: 88px;
}

.checkbox-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-description {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--gc-text-muted);
}

.tool-description .codicon {
  margin-top: 2px;
  color: var(--gc-chart-blue);
}
</style>
