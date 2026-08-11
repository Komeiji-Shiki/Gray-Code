<script setup lang="ts">
/**
 * ImportModesDialog - 导入提示词模式对话框（Teleport 到 body）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：payload/错误信息由父组件通过 props 注入，编辑/关闭/确认/导出/
 *   文件选择通过 emit 上报；隐藏文件 input 的 DOM ref 属渲染职责，随本组件内聚。
 */
import { ref } from 'vue'
import { t } from '@/i18n'

defineProps<{
  payloadText: string
  errorMessage: string
}>()

const emit = defineEmits<{
  (event: 'update:payloadText', value: string): void
  (event: 'update:errorMessage', value: string): void
  (event: 'close'): void
  (event: 'confirm'): void
  (event: 'exportAll'): void
  (event: 'fileChange', file: Event): void
}>()

const fileInputRef = ref<HTMLInputElement | null>(null)

function triggerFilePicker() {
  fileInputRef.value?.click()
}
</script>

<template>
  <!-- 导入模式对话框 -->
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div class="import-dialog-overlay" @click.self="emit('close')">
        <div class="import-dialog">
          <div class="import-dialog-header">
            <i class="codicon codicon-cloud-upload"></i>
            <span>{{ t('components.settings.promptSettings.modes.import') }}</span>
          </div>
          <div class="import-dialog-body">
            <p class="import-dialog-description">
              {{ t('components.settings.promptSettings.modes.importDescription') }}
            </p>
            <div class="import-dialog-toolbar">
              <button class="small-btn" type="button" @click="triggerFilePicker">
                <i class="codicon codicon-folder-opened"></i>
                {{ t('components.settings.promptSettings.modes.importFromFile') }}
              </button>
              <button class="small-btn" type="button" @click="emit('exportAll')">
                <i class="codicon codicon-export"></i>
                {{ t('components.settings.promptSettings.modes.exportAll') }}
              </button>
            </div>
            <input
              ref="fileInputRef"
              type="file"
              accept="application/json,.json"
              class="hidden-file-input"
              @change="(event: Event) => emit('fileChange', event)"
            />
            <textarea
              :value="payloadText"
              @input="emit('update:payloadText', ($event.target as HTMLTextAreaElement).value)"
              class="import-textarea"
              :placeholder="t('components.settings.promptSettings.modes.importPlaceholder')"
              rows="12"
            ></textarea>
            <p v-if="errorMessage" class="import-error">
              <i class="codicon codicon-warning"></i>
              {{ errorMessage }}
            </p>
          </div>
          <div class="import-dialog-footer">
            <button class="small-btn" type="button" @click="emit('close')">
              {{ t('common.cancel') }}
            </button>
            <button class="import-confirm-btn" type="button" :disabled="!payloadText.trim()" @click="emit('confirm')">
              {{ t('components.settings.promptSettings.modes.importConfirm') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.import-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}

.import-dialog {
  width: min(720px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

.import-dialog-header,
.import-dialog-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.import-dialog-header {
  font-size: 14px;
  font-weight: 600;
}

.import-dialog-header .codicon {
  color: var(--vscode-editorInfo-foreground);
}

.import-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 14px 16px;
  overflow: auto;
}

.import-dialog-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
}

.import-dialog-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.import-dialog-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: none;
}

.import-confirm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 80px;
  padding: 8px 16px;
  font-size: 13px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.import-confirm-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.import-confirm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.import-textarea {
  width: 100%;
  min-height: 240px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  resize: vertical;
  outline: none;
}

.import-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.hidden-file-input {
  display: none;
}

.import-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-errorForeground);
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.15s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.small-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.small-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
