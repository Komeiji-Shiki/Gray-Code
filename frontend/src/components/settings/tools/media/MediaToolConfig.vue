<script setup lang="ts">
/**
 * Media 工具通用配置组件
 *
 * 功能：
 * 1. 配置是否直接返回图片给 AI
 * 2. 可以被各个 media 工具设置面板复用
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, onMounted, watch } from 'vue'
import { CustomCheckbox } from '../../../common'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'

const props = defineProps<{
  /** 工具名称 */
  toolName: string
  /** 工具显示名称 */
  displayName: string
  /** 工具图标（codicon class） */
  icon: string
  /** 工具描述 */
  description?: string
}>()

// 是否直接返回图片给 AI（默认关闭以节省 token）
const returnImageToAI = ref(false)

// 保存状态
const isSaving = ref(false)

// 加载状态
const isLoading = ref(false)

// 首次加载回写标记：加载配置会触发 watch，跳过这一次自动保存（避免回声写入）
let skipNextWatchSave = false

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ config: { returnImageToAI?: boolean } }>(MESSAGE_NAMES['tools.getToolConfig'], {
      toolName: props.toolName
    })
    if (response?.config?.returnImageToAI !== undefined) {
      skipNextWatchSave = true
      returnImageToAI.value = response.config.returnImageToAI
    }
  } catch (error) {
    console.error(`Failed to load ${props.toolName} config:`, error)
  } finally {
    isLoading.value = false
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  try {
    await sendToExtension(MESSAGE_NAMES['tools.updateToolConfig'], {
      toolName: props.toolName,
      config: {
        returnImageToAI: returnImageToAI.value
      }
    })
  } catch (error) {
    console.error(`Failed to save ${props.toolName} config:`, error)
  } finally {
    isSaving.value = false
  }
}

// 监听配置变化，自动保存
// 首次加载回写（loadConfig 中设置标记）时跳过，避免把刚读到的值原样写回后端
watch(returnImageToAI, () => {
  if (skipNextWatchSave) {
    skipNextWatchSave = false
    return
  }
  saveConfig()
})

// 组件挂载时加载配置
onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="media-tool-config">
    <div class="config-section">
      <div class="section-header">
        <i :class="['codicon', icon]"></i>
        <span>{{ displayName }}</span>
      </div>
      
      <div class="section-content">
        <!-- 加载状态 -->
        <div v-if="isLoading" class="loading-state">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.toolSettings.common.loading') }}</span>
        </div>
        
        <div v-else class="config-options">
          <!-- 返回图片给 AI 配置 -->
          <div class="config-item">
            <div class="config-item-left">
              <CustomCheckbox
                v-model="returnImageToAI"
                :disabled="isSaving"
              />
              <div class="config-item-info">
                <div class="config-item-label">{{ t('components.settings.toolSettings.media.common.returnImageToAI') }}</div>
                <div class="config-item-description">
                  {{ t('components.settings.toolSettings.media.common.returnImageDesc') }}
                  <br />
                  {{ t('components.settings.toolSettings.media.common.returnImageDescDetail') }}
                </div>
              </div>
            </div>
          </div>
          
          <!-- 描述信息 -->
          <div v-if="description" class="tool-description">
            <i class="codicon codicon-info"></i>
            <span>{{ description }}</span>
          </div>
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
.media-tool-config {
  padding: 12px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
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
  color: var(--vscode-foreground);
}

.section-header .codicon {
  font-size: 14px;
  color: var(--vscode-charts-blue);
}

.section-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 加载状态 */
.loading-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 配置选项 */
.config-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.config-item-left {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.config-item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-item-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.config-item-description {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
}

/* 工具描述 */
.tool-description {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.tool-description .codicon {
  font-size: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

/* 保存状态 */
.save-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>