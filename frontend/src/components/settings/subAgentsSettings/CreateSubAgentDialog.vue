<script setup lang="ts">
/**
 * CreateSubAgentDialog - 新建子代理对话框
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：预设模板/渠道选项/名称草稿/错误文案与回调均由父组件注入。
 */
import { useI18n } from '@/i18n'
import { CustomSelect, type SelectOption } from '../../common'
import type { SubAgentPreset } from './types'

defineProps<{
  newAgentName: string
  newAgentChannelId: string
  selectedPresetId: string
  presets: SubAgentPreset[]
  channelOptions: SelectOption[]
  createError: string
  isCreating: boolean
  presetName: (preset: SubAgentPreset) => string
  presetDescription: (preset: SubAgentPreset) => string
  onSelectPreset: (presetId: string) => void
  onClose: () => void
  onCreate: () => void
}>()

const emit = defineEmits<{
  (e: 'update:newAgentName', value: string): void
  (e: 'update:newAgentChannelId', value: string): void
}>()

const { t } = useI18n()

function onNameInput(event: Event) {
  emit('update:newAgentName', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="dialog-overlay" @click.self="onClose">
    <div class="dialog">
      <div class="dialog-header">
        <h4>{{ t('components.settings.subagents.createDialog.title') }}</h4>
        <button class="close-btn" @click="onClose">
          <i class="codicon codicon-close"></i>
        </button>
      </div>

      <div class="dialog-body">
        <!-- 预设模板选择：空白 + 内置模板；选中后预填名称/提示词/工具配置，创建后均可在编辑界面调整 -->
        <div class="form-group">
          <label>{{ t('components.settings.subagents.createDialog.templateLabel') }}</label>
          <div class="preset-list">
            <div
              class="preset-card"
              :class="{ selected: selectedPresetId === '' }"
              @click="onSelectPreset('')"
            >
              <i class="codicon codicon-file"></i>
              <div class="preset-info">
                <span class="preset-name">{{ t('components.settings.subagents.presets.blank.name') }}</span>
                <span class="preset-desc">{{ t('components.settings.subagents.presets.blank.description') }}</span>
              </div>
            </div>
            <div
              v-for="preset in presets"
              :key="preset.presetId"
              class="preset-card"
              :class="{ selected: selectedPresetId === preset.presetId }"
              @click="onSelectPreset(preset.presetId)"
            >
              <i class="codicon" :class="preset.icon"></i>
              <div class="preset-info">
                <span class="preset-name">{{ presetName(preset) }}</span>
                <span class="preset-desc">{{ presetDescription(preset) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.subagents.createDialog.nameLabel') }}</label>
          <input
            :value="newAgentName"
            type="text"
            :placeholder="t('components.settings.subagents.createDialog.namePlaceholder')"
            @input="onNameInput"
            @keyup.enter="onCreate"
          />
        </div>

        <div class="form-group">
          <label>{{ t('components.settings.subagents.channel') }}</label>
          <CustomSelect
            :modelValue="newAgentChannelId"
            :options="channelOptions"
            :placeholder="t('components.settings.subagents.selectChannel')"
            @update:modelValue="emit('update:newAgentChannelId', $event)"
          />
        </div>

        <div v-if="createError" class="error-message">
          {{ createError }}
        </div>
      </div>

      <div class="dialog-footer">
        <button class="secondary-btn" @click="onClose">
          {{ t('common.cancel') }}
        </button>
        <button class="primary-btn" @click="onCreate" :disabled="isCreating">
          <i v-if="isCreating" class="codicon codicon-loading codicon-modifier-spin"></i>
          {{ t('common.create') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}

.preset-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  cursor: pointer;
  background: var(--vscode-editor-background);
}

.preset-card:hover {
  background: var(--vscode-list-hoverBackground);
}

.preset-card.selected {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
}

.preset-card > .codicon {
  margin-top: 2px;
  font-size: 16px;
  color: var(--vscode-symbolIcon-classForeground);
}

.preset-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preset-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.preset-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

.dialog {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 8px;
  min-width: 400px;
  max-width: 500px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--vscode-widget-border);
}

.dialog-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  border-radius: 4px;
}

.close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.dialog-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid var(--vscode-widget-border);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.form-group input,
.form-group textarea {
  padding: 6px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.error-message {
  padding: 8px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  color: var(--vscode-errorForeground);
  font-size: 12px;
}

.primary-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.primary-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.secondary-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.secondary-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
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
