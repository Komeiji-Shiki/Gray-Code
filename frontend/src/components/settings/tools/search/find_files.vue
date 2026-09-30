<script setup lang="ts">
/**
 * Find Files 工具配置面板
 *
 * 功能：
 * 1. 配置排除模式列表（glob 格式）
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'

// 排除模式列表
const excludePatterns = ref<string[]>([])

// 新增模式输入
const newPattern = ref('')

// 保存状态
const isSaving = ref(false)

// 加载状态
const isLoading = ref(false)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ config: { excludePatterns: string[] } }>(MESSAGE_NAMES['tools.getFindFilesConfig'], {})
    if (response?.config?.excludePatterns) {
      excludePatterns.value = response.config.excludePatterns
    }
  } catch (error) {
    console.error('Failed to load find_files config:', error)
  } finally {
    isLoading.value = false
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  try {
    await sendToExtension(MESSAGE_NAMES['tools.updateFindFilesConfig'], {
      config: {
        excludePatterns: [...excludePatterns.value]
      }
    })
  } catch (error) {
    console.error('Failed to save find_files config:', error)
  } finally {
    isSaving.value = false
  }
}

// 添加模式
function addPattern() {
  const pattern = newPattern.value.trim()
  if (pattern && !excludePatterns.value.includes(pattern)) {
    excludePatterns.value.push(pattern)
    newPattern.value = ''
    saveConfig()
  }
}

// 删除模式
function removePattern(index: number) {
  excludePatterns.value.splice(index, 1)
  saveConfig()
}

// 组件挂载时加载配置
onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="find-files-config">
    <div class="config-section">
      <div class="section-header">
        <i class="codicon codicon-exclude"></i>
        <span>{{ t('components.settings.toolSettings.search.findFiles.excludeList') }}</span>
        <span class="hint">{{ t('components.settings.toolSettings.search.findFiles.excludeListHint') }}</span>
      </div>
      
      <div class="section-content">
        <!-- 加载状态 -->
        <div v-if="isLoading" class="loading-state">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.toolSettings.common.loading') }}</span>
        </div>
        
        <!-- 当前排除列表 -->
        <div v-else class="pattern-list">
          <div
            v-for="(pattern, index) in excludePatterns"
            :key="index"
            class="pattern-item"
          >
            <span class="pattern-text">{{ pattern }}</span>
            <button
              class="remove-btn"
              @click="removePattern(index)"
              :title="t('components.settings.toolSettings.search.findFiles.deleteTooltip')"
            >
              <i class="codicon codicon-close"></i>
            </button>
          </div>
        </div>
        
        <!-- 添加新模式 -->
        <div class="add-pattern">
          <input
            v-model="newPattern"
            type="text"
            class="pattern-input"
            :placeholder="t('components.settings.toolSettings.search.findFiles.inputPlaceholder')"
            @keyup.enter="addPattern"
          />
          <button
            class="add-btn"
            @click="addPattern"
            :disabled="!newPattern.trim()"
          >
            <i class="codicon codicon-add"></i>
            {{ t('components.settings.toolSettings.search.findFiles.addButton') }}
          </button>
        </div>
        
        <!-- 保存状态 -->
        <div v-if="isSaving" class="save-status">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.toolSettings.common.saving') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.find-files-config {
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
  color: var(--gc-chart-yellow);
}

.section-header .hint {
  font-size: 11px;
  font-weight: normal;
  color: var(--gc-text-muted);
}

.section-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 模式列表 */
.pattern-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pattern-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
  border-radius: var(--gc-radius-sm);
  font-size: 11px;
  font-family: var(--gc-font-code);
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: none;
  border: none;
  color: var(--gc-badge-fg);
  opacity: 0.6;
  cursor: pointer;
  transition: opacity 0.15s;
}

.remove-btn:hover {
  opacity: 1;
}

.remove-btn .codicon {
  font-size: 12px;
}

/* 添加新模式 */
.add-pattern {
  display: flex;
  gap: 8px;
}

.pattern-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  font-family: var(--gc-font-code);
}

.pattern-input:focus {
  outline: none;
  border-color: var(--gc-focus-border);
}

.pattern-input::placeholder {
  color: var(--gc-text-placeholder);
}

.add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--gc-button-secondary);
  color: var(--gc-text-on-secondary);
  border: none;
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.add-btn:hover:not(:disabled) {
  background: var(--gc-button-secondary-hover);
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-btn .codicon {
  font-size: 14px;
}

/* 加载状态 */
.loading-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--gc-text-muted);
}

/* 保存状态 */
.save-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--gc-text-muted);
}

.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>