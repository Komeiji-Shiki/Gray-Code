<script setup lang="ts">
/**
 * CheckpointDeleteConfirmDialog - 删除确认弹窗（对话批量 / 存档点批量）
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：确认状态与动作全部由父组件通过 props/emits 注入（状态仍归父组件的
 *   useCheckpointCleanup 单一实例持有），自身不持有任何响应式状态。
 */
import { t } from '@/i18n'
import type { DeleteConfirmState } from '@/composables/useCheckpointCleanup'

defineProps<{
  state: DeleteConfirmState | null
  isBatchDeleting: boolean
  formatSize: (size: number) => string
}>()

defineEmits<{
  (e: 'cancel'): void
  (e: 'confirm'): void
}>()
</script>

<template>
  <!-- 删除确认对话框 -->
  <div v-if="state" class="delete-confirm-overlay" @click.self="$emit('cancel')">
    <div class="delete-confirm-dialog">
      <div class="dialog-header">
        <i class="codicon codicon-warning"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.title') }}</span>
      </div>
      <div class="dialog-body">
        <p>{{ state.title }}</p>
        <p class="delete-stats">
          {{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.stats', {
            count: state.count,
            size: formatSize(state.size)
          }) }}
        </p>
        <p class="warning-text">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.warning') }}</p>
      </div>
      <div class="dialog-footer">
        <button class="btn-cancel" @click="$emit('cancel')">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.cancel') }}</button>
        <button class="btn-delete" :disabled="isBatchDeleting" @click="$emit('confirm')">{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.delete') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 删除确认对话框 */
.delete-confirm-overlay {
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

.delete-confirm-dialog {
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  width: 400px;
  max-width: 90%;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-weight: 500;
  font-size: 14px;
}

.dialog-header .codicon-warning {
  color: var(--vscode-inputValidation-warningForeground);
  font-size: 18px;
}

.dialog-body {
  padding: 16px;
}

.dialog-body p {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
}

.dialog-body p:last-child {
  margin-bottom: 0;
}

.delete-stats {
  color: var(--vscode-descriptionForeground);
}

.warning-text {
  color: var(--vscode-inputValidation-warningForeground);
  font-weight: 500;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.btn-cancel,
.btn-delete {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  border: none;
}

.btn-cancel {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn-cancel:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.btn-delete {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.btn-delete:hover {
  opacity: 0.9;
}

.btn-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
