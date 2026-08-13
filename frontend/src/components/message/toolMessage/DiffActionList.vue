<script setup lang="ts">
/**
 * DiffActionList - Diff 工具独立确认操作栏（从 ToolMessage.vue 抽出，F-07）。
 * 按独立 pending diff 渲染；倒计时/状态展示与 confirmDiff / rejectDiff 语义原样保留。
 */
import { useI18n } from '../../../i18n'
import { confirmDiff, rejectDiff, globalApplyDiffConfig } from '../diffReviewController'
import type { PendingDiffView } from './types'

const { t } = useI18n()

defineProps<{
  pendingDiffs: PendingDiffView[]
}>()
</script>

<template>
  <div class="diff-action-list">
    <div v-for="pendingDiff in pendingDiffs" :key="pendingDiff.id" class="diff-action-footer">
      <div class="diff-action-file">
        <span class="codicon codicon-file-code"></span>
        <span class="diff-action-file-path">{{ pendingDiff.filePath }}</span>
      </div>
      <div class="footer-top" v-if="globalApplyDiffConfig.autoSave">
        <template v-if="pendingDiff.autoSaveAt !== undefined">
          <div class="timer-container">
            <div class="timer-bar" :style="{ width: pendingDiff.progress + '%' }"></div>
          </div>
          <span class="timer-text">{{ (pendingDiff.timeLeft / 1000).toFixed(1) }}s</span>
        </template>
        <span v-else-if="pendingDiff.isPreparing" class="timer-text">{{ t('common.loading') }}</span>
      </div>
      <div class="footer-buttons">
        <button
          class="confirm-btn-primary"
          :disabled="pendingDiff.isProcessing"
          @click.stop="confirmDiff(pendingDiff.id)"
        >
          <span class="codicon codicon-check"></span>
          {{ t('common.save') }}
        </button>
        <button
          class="reject-btn-secondary"
          :disabled="pendingDiff.isProcessing"
          @click.stop="rejectDiff(pendingDiff.id)"
        >
          <span class="codicon codicon-close"></span>
          {{ t('components.message.tool.reject') }}
        </button>
      </div>
      <div v-if="pendingDiff.isProcessing" class="diff-action-state">
        <span class="codicon codicon-loading codicon-modifier-spin"></span>
        <span>{{ pendingDiff.isPreparing ? t('common.loading') : t('components.tools.executing') }}</span>
      </div>
      <div v-else-if="pendingDiff.error" class="diff-action-error">
        <span class="codicon codicon-error"></span>
        <span>{{ pendingDiff.error }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Diff 工具操作栏样式 */
.diff-action-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diff-action-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
}

.diff-action-file {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.diff-action-file .codicon {
  color: var(--vscode-charts-blue);
}

.diff-action-file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-top {
  display: flex;
  align-items: center;
  gap: 4px;
}

.timer-container {
  flex: 1;
  position: relative;
  height: 4px;
  background: rgba(128, 128, 128, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.timer-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--vscode-charts-blue);
  transition: width 0.05s linear;
}

.timer-text {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  min-width: 24px;
  text-align: right;
}

.footer-buttons {
  display: flex;
  gap: 4px;
  width: 100%;
}

.footer-buttons button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 2px;
  border: none;
  transition: opacity 0.12s ease;
}

.footer-buttons button:disabled {
  opacity: 0.65;
  cursor: default;
}

.diff-action-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.diff-action-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 2px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 11px;
}

.confirm-btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.confirm-btn-primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.reject-btn-secondary {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.reject-btn-secondary:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
</style>
