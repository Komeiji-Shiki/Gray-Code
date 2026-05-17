<script setup lang="ts">
/**
 * Read File 工具配置面板
 */

import { ref, onMounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'

type OutsideWorkspaceReadAccess = 'deny' | 'ask' | 'allow'

const outsideWorkspaceAccess = ref<OutsideWorkspaceReadAccess>('deny')
const isSaving = ref(false)
const isLoading = ref(false)

const accessOptions: Array<{ value: OutsideWorkspaceReadAccess; labelKey: string; descKey: string }> = [
  {
    value: 'deny',
    labelKey: 'components.settings.toolSettings.files.outsideWorkspaceAccess.deny',
    descKey: 'components.settings.toolSettings.files.readFile.outsideWorkspaceDenyDesc'
  },
  {
    value: 'ask',
    labelKey: 'components.settings.toolSettings.files.outsideWorkspaceAccess.ask',
    descKey: 'components.settings.toolSettings.files.readFile.outsideWorkspaceAskDesc'
  },
  {
    value: 'allow',
    labelKey: 'components.settings.toolSettings.files.outsideWorkspaceAccess.allow',
    descKey: 'components.settings.toolSettings.files.readFile.outsideWorkspaceAllowDesc'
  }
]

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ config: { outsideWorkspaceAccess?: OutsideWorkspaceReadAccess } }>('tools.getToolConfig', {
      toolName: 'read_file'
    })
    outsideWorkspaceAccess.value = response?.config?.outsideWorkspaceAccess ?? 'deny'
  } catch (error) {
    console.error('Failed to load read_file config:', error)
  } finally {
    isLoading.value = false
  }
}

async function saveConfig() {
  isSaving.value = true
  try {
    await sendToExtension('tools.updateToolConfig', {
      toolName: 'read_file',
      config: {
        outsideWorkspaceAccess: outsideWorkspaceAccess.value
      }
    })
  } catch (error) {
    console.error('Failed to save read_file config:', error)
  } finally {
    isSaving.value = false
  }
}

function updateAccess(value: OutsideWorkspaceReadAccess) {
  if (outsideWorkspaceAccess.value === value) return
  outsideWorkspaceAccess.value = value
  saveConfig()
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="file-access-config">
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.toolSettings.common.loading') }}</span>
    </div>

    <template v-else>
      <div class="config-section">
        <div class="section-header">
          <i class="codicon codicon-folder-opened"></i>
          <span>{{ t('components.settings.toolSettings.files.readFile.outsideWorkspaceAccess') }}</span>
        </div>

        <div class="section-content">
          <div class="option-list">
            <button
              v-for="option in accessOptions"
              :key="option.value"
              :class="['option-card', { active: outsideWorkspaceAccess === option.value }]"
              :disabled="isSaving"
              @click="updateAccess(option.value)"
            >
              <span class="option-title">{{ t(option.labelKey) }}</span>
              <span class="option-desc">{{ t(option.descKey) }}</span>
            </button>
          </div>

          <div class="config-tip">
            <i class="codicon codicon-info"></i>
            <span>{{ t('components.settings.toolSettings.files.readFile.outsideWorkspaceTip') }}</span>
          </div>

          <div v-if="isSaving" class="save-status">
            <i class="codicon codicon-loading codicon-modifier-spin"></i>
            <span>{{ t('components.settings.toolSettings.common.saving') }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-access-config {
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
  color: var(--vscode-charts-yellow);
}

.section-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.option-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.option-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  text-align: left;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
  cursor: pointer;
}

.option-card:hover:not(:disabled) {
  border-color: var(--vscode-focusBorder);
}

.option-card.active {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
}

.option-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.option-title {
  font-size: 12px;
  font-weight: 600;
}

.option-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
}

.config-tip,
.save-status,
.loading-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
</style>
