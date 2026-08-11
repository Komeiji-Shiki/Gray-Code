<script setup lang="ts">
/**
 * ModeSelectorBar - 提示词模式选择栏（下拉选择 + 保存/添加/复制/导出/导入/重命名/删除）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：选中值、选项、保存态由父组件通过 props 注入，动作全部通过 emit 上报，
 *   自身不持有任何响应式状态（状态仍由 PromptSettings.vue 持有）。
 */
import { CustomSelect, type SelectOption } from '../../common'
import { t } from '@/i18n'

defineProps<{
  selectedModeId: string
  modeOptions: SelectOption[]
  isSaving: boolean
  canDelete: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'save'): void
  (event: 'add'): void
  (event: 'duplicate'): void
  (event: 'exportCurrent'): void
  (event: 'import'): void
  (event: 'rename'): void
  (event: 'delete'): void
}>()
</script>

<template>
  <!-- 模式选择栏 -->
  <div class="mode-selector-bar" data-search-anchor="prompt-mode-selector">
    <div class="mode-selector-left">
      <label class="mode-label">
        <i class="codicon codicon-symbol-method"></i>
        <span class="mode-label-text">{{ t('components.settings.promptSettings.modes.label') }}</span>
      </label>
      <CustomSelect
        :model-value="selectedModeId"
        :options="modeOptions"
        :placeholder="t('components.settings.promptSettings.modes.label')"
        :searchable="true"
        class="mode-select-dropdown"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
    <div class="mode-actions">
      <button
        class="mode-action-btn save-action-btn"
        @click="emit('save')"
        :disabled="isSaving"
        :title="t('components.settings.promptSettings.saveButton')"
      >
        <i :class="['codicon', isSaving ? 'codicon-loading codicon-modifier-spin' : 'codicon-save']"></i>
        <span class="save-action-text">{{ t('components.settings.promptSettings.saveButton') }}</span>
      </button>
      <span class="mode-actions-divider"></span>
      <button class="mode-action-btn" @click="emit('add')" :title="t('components.settings.promptSettings.modes.add')">
        <i class="codicon codicon-add"></i>
      </button>
      <button
        class="mode-action-btn"
        @click="emit('duplicate')"
        :title="t('components.settings.promptSettings.modes.duplicate')"
      >
        <i class="codicon codicon-copy"></i>
      </button>
      <button
        class="mode-action-btn"
        @click="emit('exportCurrent')"
        :title="t('components.settings.promptSettings.modes.exportCurrent')"
      >
        <svg class="mode-action-icon" viewBox="8 11 50 38" fill="none" stroke="currentColor" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M20 14h13l10 10v18a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3Z" stroke-width="3"/>
          <path d="M33 14v10h10" stroke-width="3"/>
          <path d="M30 32h20" stroke-width="4" stroke-linecap="round"/>
          <path d="M50 27l8 5-8 5z" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      <button
        class="mode-action-btn"
        @click="emit('import')"
        :title="t('components.settings.promptSettings.modes.import')"
      >
        <svg class="mode-action-icon" viewBox="8 11 50 38" fill="none" stroke="currentColor" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M20 14h13l10 10v18a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3Z" stroke-width="3"/>
          <path d="M33 14v10h10" stroke-width="3"/>
          <path d="M8 32h20" stroke-width="4" stroke-linecap="round"/>
          <path d="M28 27l8 5-8 5z" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      <button
        class="mode-action-btn"
        @click="emit('rename')"
        :title="t('components.settings.promptSettings.modes.rename')"
      >
        <i class="codicon codicon-edit"></i>
      </button>
      <button
        class="mode-action-btn danger"
        @click="emit('delete')"
        :title="t('components.settings.promptSettings.modes.delete')"
        :disabled="!canDelete"
      >
        <i class="codicon codicon-trash"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 模式选择栏 */
.mode-selector-bar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 10px 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.mode-selector-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 240px;
  min-width: 0;
}

.mode-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
  white-space: nowrap;
  flex-shrink: 0;
}

.mode-label-text {
  white-space: nowrap;
}

/* 模式选择下拉框固定宽度 */
.mode-select-dropdown {
  width: auto;
  min-width: 150px;
  max-width: 260px;
  flex: 1 1 160px;
}

.mode-select-dropdown :deep(.select-trigger) {
  width: 100%;
}

.mode-select-dropdown :deep(.selected-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 展开时列表项自动换行 */
.mode-select-dropdown :deep(.select-dropdown) {
  min-width: 200px;
  width: auto;
  max-width: 300px;
}

.mode-select-dropdown :deep(.option-label) {
  white-space: normal;
  word-break: break-word;
}

.mode-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  flex: 0 0 auto;
  margin-left: auto;
}

.mode-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background 0.1s ease;
}

.mode-action-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.mode-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mode-action-btn.danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground);
}

.mode-action-btn .codicon {
  font-size: 14px;
}

.mode-action-btn .mode-action-icon {
  width: 18px;
  height: 18px;
}

.save-action-btn {
  width: auto; /* 覆盖 .mode-action-btn 的 width: 24px（保存按钮按内容撑开） */
  min-width: 88px;
  flex-shrink: 0; /* 不被 flex 压缩，避免「保存配置」文字被挤成两行 */
  height: 28px;
  padding: 0 12px;
  gap: 6px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  font-size: 13px;
  font-weight: 500;
}

.save-action-text {
  white-space: nowrap; /* 文字强制单行，窄窗口下不再按字符断行 */
}

.save-action-btn .codicon {
  font-size: 15px;
}

.save-action-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.save-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mode-actions-divider {
  width: 1px;
  align-self: stretch;
  margin: 3px 4px;
  background: var(--vscode-panel-border);
}

@media (max-width: 520px) {
  .mode-selector-left {
    flex-basis: 100%;
  }

  .mode-actions {
    width: 100%;
    flex-wrap: wrap;
  }
}

@media (max-width: 380px) {
  .mode-label-text {
    display: none;
  }

  .mode-selector-left {
    flex-basis: 100%;
  }
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
