<script setup lang="ts">
/**
 * StorageMigrateDialog - 存储路径迁移确认对话框
 *
 * 从 SettingsPanel.vue 模板拆分（T12 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：显示状态与迁移中标志由父组件通过 props 注入（v-model 协议回写），
 *   取消/确认通过 emits 回传，迁移执行仍由父组件驱动。
 */
import { t } from '@/i18n'
import { Modal } from '../../common'

defineProps<{
  show: boolean
  isMigrating: boolean
}>()

defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'confirm'): void
}>()
</script>

<template>
  <!-- 迁移确认对话框 -->
  <Modal
    :model-value="show"
    :title="t('components.settings.storageSettings.dialog.migrateTitle')"
    @update:model-value="$emit('update:show', $event)"
  >
    <div class="migrate-dialog-content">
      <p>{{ t('components.settings.storageSettings.dialog.migrateMessage') }}</p>
      <p class="migrate-warning">
        <i class="codicon codicon-warning"></i>
        {{ t('components.settings.storageSettings.dialog.migrateWarning') }}
      </p>
    </div>
    <template #footer>
      <button class="dialog-btn" :disabled="isMigrating" @click="$emit('update:show', false)">
        {{ t('components.settings.storageSettings.dialog.cancel') }}
      </button>
      <button class="dialog-btn primary" :disabled="isMigrating" @click="$emit('confirm')">
        {{ t('components.settings.storageSettings.dialog.confirm') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* 迁移对话框 */
.migrate-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.migrate-dialog-content p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.migrate-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 200, 0, 0.1);
  border-radius: 4px;
  color: var(--vscode-editorWarning-foreground);
}

.migrate-warning .codicon {
  flex-shrink: 0;
  margin-top: 2px;
}

.dialog-btn {
  padding: 6px 14px;
  font-size: 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.dialog-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.dialog-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
