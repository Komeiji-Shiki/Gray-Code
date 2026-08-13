<script setup lang="ts">
/**
 * RenameSubAgentDialog - 重命名子代理对话框
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）。
 */
import { useI18n } from '@/i18n'

defineProps<{
  editingName: string
  renameError: string
  onCancel: () => void
  onSave: () => void
}>()

const emit = defineEmits<{
  (e: 'update:editingName', value: string): void
}>()

const { t } = useI18n()

function onNameInput(event: Event) {
  emit('update:editingName', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="dialog-overlay" @click.self="onCancel">
    <div class="dialog">
      <div class="dialog-header">
        <h4>{{ t('components.settings.subagents.rename') }}</h4>
        <button class="close-btn" @click="onCancel">
          <i class="codicon codicon-close"></i>
        </button>
      </div>

      <div class="dialog-body">
        <div class="form-group">
          <label>{{ t('components.settings.subagents.createDialog.nameLabel') }}</label>
          <input
            :value="editingName"
            type="text"
            @input="onNameInput"
            @keyup.enter="onSave"
          />
        </div>

        <div v-if="renameError" class="error-message">
          {{ renameError }}
        </div>
      </div>

      <div class="dialog-footer">
        <button class="secondary-btn" @click="onCancel">
          {{ t('common.cancel') }}
        </button>
        <button class="primary-btn" @click="onSave">
          {{ t('common.save') }}
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
</style>
