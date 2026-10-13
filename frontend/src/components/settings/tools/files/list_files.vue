<script setup lang="ts">
/**
 * List Files 工具配置面板
 *
 * 功能：
 * 1. 配置忽略列表（支持通配符）
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'
import { PatternListEditor } from '@/components/common'

// 忽略列表
const ignorePatterns = ref<string[]>([])

// 保存状态
const isSaving = ref(false)

// 加载状态
const isLoading = ref(false)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ config: { ignorePatterns: string[] } }>(MESSAGE_NAMES['tools.getToolConfig'], {
      toolName: 'list_files'
    })
    if (response?.config?.ignorePatterns) {
      ignorePatterns.value = response.config.ignorePatterns
    }
  } catch (error) {
    console.error('Failed to load list_files config:', error)
  } finally {
    isLoading.value = false
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  try {
    // 将响应式数组转换为普通数组以便序列化
    await sendToExtension(MESSAGE_NAMES['tools.updateListFilesConfig'], {
      config: {
        ignorePatterns: [...ignorePatterns.value]
      }
    })
  } catch (error) {
    console.error('Failed to save list_files config:', error)
  } finally {
    isSaving.value = false
  }
}

function updatePatterns(patterns: string[]) {
  ignorePatterns.value = patterns
  void saveConfig()
}

// 组件挂载时加载配置
onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="list-files-config">
    <div class="config-section">
      <div class="section-header">
        <i class="codicon codicon-exclude"></i>
        <span>{{ t('components.settings.toolSettings.files.listFiles.ignoreList') }}</span>
        <span class="hint">{{ t('components.settings.toolSettings.files.listFiles.ignoreListHint') }}</span>
      </div>
      
      <div class="section-content">
        <!-- 加载状态 -->
        <div v-if="isLoading" class="loading-state">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.toolSettings.common.loading') }}</span>
        </div>
        
        <PatternListEditor
          v-else
          :model-value="ignorePatterns"
          :placeholder="t('components.settings.toolSettings.files.listFiles.inputPlaceholder')"
          :add-label="t('components.settings.toolSettings.files.listFiles.addButton')"
          :remove-label="t('components.settings.toolSettings.files.listFiles.deleteTooltip')"
          @update:model-value="updatePatterns"
        />
        
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
.list-files-config {
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
