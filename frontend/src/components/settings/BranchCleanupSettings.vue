<script setup lang="ts">
/**
 * BranchCleanupSettings - 分支清理设置区块（TREE-09 / MIG-06）
 *
 * 与存档清理并列的新增区块（已确认决策 3）：
 * - 软删分支数量展示（全量扫描）
 * - 一键清理过期软删（调后端 prune API）
 * - 保留期配置输入（默认 30 天，0 = 不自动清理）
 *
 * 文案三语同步（zh-CN / en / ja），遵守 languageParity.test.ts。
 */

import { onMounted } from 'vue'
import { t } from '@/i18n'
import { useBranchCleanup } from '@/composables/useBranchCleanup'

const {
  deletedCount,
  deletedConversationCount,
  isCountLoading,
  countError,
  isPruning,
  pruneFeedback,
  pruneError,
  pruneSkippedCount,
  retentionDraft,
  isRetentionLoading,
  isRetentionSaving,
  retentionError,
  retentionDaysValid,
  loadDeletedCount,
  pruneDeleted,
  loadRetention,
  saveRetention
} = useBranchCleanup()

onMounted(() => {
  loadDeletedCount()
  loadRetention()
})
</script>

<template>
  <div class="branch-cleanup-settings">
    <div class="divider"></div>
    <div class="setting-group" data-search-anchor="branch-cleanup">
      <h4 class="group-title">
        <i class="codicon codicon-git-branch"></i>
        <span>{{ t('components.settings.checkpoint.sections.branchCleanup.title') }}</span>
      </h4>
      <p class="setting-description">{{ t('components.settings.checkpoint.sections.branchCleanup.description') }}</p>

      <!-- 软删分支数量 -->
      <div class="deleted-count-row">
        <span class="deleted-count-label">
          {{ t('components.settings.checkpoint.sections.branchCleanup.deletedCountLabel') }}
        </span>
        <span v-if="isCountLoading" class="hint">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
        </span>
        <span v-else-if="countError" class="error-text">
          {{ t('components.settings.checkpoint.sections.branchCleanup.countLoadFailed') }}
        </span>
        <span v-else-if="deletedCount > 0" class="deleted-count-value">
          {{ t('components.settings.checkpoint.sections.branchCleanup.deletedCountValue', {
            count: deletedCount,
            conversations: deletedConversationCount
          }) }}
        </span>
        <span v-else class="hint">{{ t('components.settings.checkpoint.sections.branchCleanup.deletedCountEmpty') }}</span>
      </div>

      <!-- 一键清理过期软删 -->
      <div class="cleanup-actions">
        <button
          class="prune-btn"
          :disabled="isPruning || isCountLoading"
          @click="pruneDeleted"
        >
          <i v-if="isPruning" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-trash"></i>
          <span>
            {{ isPruning
              ? t('components.settings.checkpoint.sections.branchCleanup.pruneLoading')
              : t('components.settings.checkpoint.sections.branchCleanup.pruneButton') }}
          </span>
        </button>
        <span v-if="pruneFeedback !== null && !pruneError" class="success-text">
          {{ t('components.settings.checkpoint.sections.branchCleanup.pruneSuccess', { count: pruneFeedback }) }}
        </span>
        <span v-if="pruneSkippedCount > 0" class="hint skipped-hint">
          {{ t('components.settings.checkpoint.sections.branchCleanup.pruneSkipped', { count: pruneSkippedCount }) }}
        </span>
        <span v-if="pruneError" class="error-text">
          {{ t('components.settings.checkpoint.sections.branchCleanup.pruneFailed', { message: pruneError }) }}
        </span>
      </div>

      <!-- 保留期配置 -->
      <div class="form-row retention-row">
        <label>{{ t('components.settings.checkpoint.sections.branchCleanup.retention.label') }}</label>
        <input
          v-model="retentionDraft"
          class="number-input"
          type="number"
          min="0"
          step="1"
          :disabled="isRetentionLoading || isRetentionSaving"
        />
        <button
          class="retention-save-btn"
          :disabled="isRetentionSaving || !retentionDaysValid"
          @click="saveRetention"
        >
          {{ t('components.settings.checkpoint.sections.branchCleanup.retention.save') }}
        </button>
        <span v-if="retentionError" class="error-text">{{ retentionError }}</span>
        <span v-else-if="!retentionDaysValid" class="error-text">
          {{ t('components.settings.checkpoint.sections.branchCleanup.retention.invalid') }}
        </span>
        <span class="hint">{{ t('components.settings.checkpoint.sections.branchCleanup.retention.hint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.branch-cleanup-settings {
  width: 100%;
}

.setting-group {
  margin-bottom: 16px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px 0;
  color: var(--vscode-settings-headerForeground, var(--vscode-foreground));
}

.group-title .codicon {
  font-size: 14px;
}

.setting-description {
  font-size: 12px;
  line-height: 1.5;
  margin: 0 0 10px 0;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
}

.deleted-count-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12px;
}

.deleted-count-label {
  font-weight: 600;
}

.deleted-count-value {
  color: var(--vscode-settings-numberInputForeground, var(--vscode-foreground));
}

.cleanup-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.prune-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  cursor: pointer;
}

.prune-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}

.prune-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.retention-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.retention-row label {
  font-weight: 600;
  white-space: nowrap;
}

.number-input {
  width: 80px;
  padding: 3px 6px;
  font-size: 12px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.number-input:focus {
  outline: 1px solid var(--vscode-focusBorder);
}

.number-input:disabled {
  opacity: 0.6;
}

.retention-save-btn {
  padding: 3px 10px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
}

.retention-save-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.retention-save-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.hint {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
}

.error-text {
  font-size: 12px;
  color: var(--vscode-errorForeground, #f14c4c);
}

.success-text {
  font-size: 12px;
  color: var(--vscode-charts-green, #89d185);
}

.divider {
  height: 1px;
  background: var(--vscode-settings-rowHoverBackground, var(--vscode-widget-border, #3c3c3c));
  margin: 4px 0 12px 0;
}
</style>
