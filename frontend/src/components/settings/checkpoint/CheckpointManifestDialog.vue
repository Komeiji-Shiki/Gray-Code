<script setup lang="ts">
/**
 * CheckpointManifestDialog - 存档排除清单详情弹窗（EX-11，checkpoint.getManifest）
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：清单状态与动作全部由父组件通过 props/emits 注入（状态仍归父组件的
 *   useCheckpointManifest 单一实例持有），自身不持有任何响应式状态。
 */
import { t } from '@/i18n'
import type { CheckpointManifest } from '@/types'

defineProps<{
  checkpointId: string | null
  detail: CheckpointManifest | null
  isLoading: boolean
  loadError: string | null
  excludedCount: number
  enabledProfileIds: string[]
  rulesChanged: () => boolean
  profileLabel: (profileId: string) => string
  formatSize: (size: number) => string
}>()

defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <!-- EX-11: 存档排除清单详情 -->
  <div v-if="checkpointId" class="manifest-overlay" @click.self="$emit('close')">
    <div class="manifest-dialog">
      <div class="dialog-header">
        <i class="codicon codicon-filter"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestDetail') }}</span>
      </div>
      <div class="dialog-body manifest-body">
        <div v-if="isLoading" class="manifest-loading">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.checkpoint.sections.cleanup.loading') }}</span>
        </div>
        <p v-else-if="loadError" class="manifest-error">
          <i class="codicon codicon-warning"></i>
          {{ t('components.settings.checkpoint.sections.cleanup.manifestLoadFailed') }}
        </p>
        <div v-else-if="!detail" class="manifest-unavailable">
          <i class="codicon codicon-info"></i>
          <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestUnavailable') }}</span>
        </div>
        <div v-else class="manifest-content">
          <div class="manifest-stat">
            <span class="manifest-stat-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestExcludedCount') }}</span>
            <span class="manifest-stat-value">{{ excludedCount }}</span>
          </div>
          <p class="manifest-note">
            {{ t('components.settings.checkpoint.sections.cleanup.manifestNote', { count: excludedCount }) }}
          </p>
          <p v-if="rulesChanged()" class="manifest-rules-changed">
            <i class="codicon codicon-warning"></i>
            {{ t('components.settings.checkpoint.sections.cleanup.manifestRulesChanged') }}
          </p>
          <template v-if="detail.ignoreSnapshot">
            <div class="manifest-section-title">
              {{ t('components.settings.checkpoint.sections.cleanup.manifestIgnoreSnapshot') }}
            </div>
            <div class="manifest-rows">
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestRuleVersion') }}</span>
                <span>{{ detail.ignoreSnapshot.version }}</span>
              </div>
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestForcedRulesVersion') }}</span>
                <span>{{ detail.ignoreSnapshot.forcedRulesVersion }}</span>
              </div>
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestDefaultProfileVersion') }}</span>
                <span>{{ detail.ignoreSnapshot.defaultProfileVersion }}</span>
              </div>
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestMaxFileSize') }}</span>
                <span>{{ formatSize(detail.ignoreSnapshot.maxFileSizeBytes) }}</span>
              </div>
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestEnabledProfiles') }}</span>
                <span v-if="enabledProfileIds.length > 0" class="manifest-profiles">
                  {{ enabledProfileIds.map(profileLabel).join('、') }}
                </span>
                <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
              </div>
              <div class="manifest-row">
                <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestCustomPatterns') }}</span>
                <span v-if="detail.ignoreSnapshot.customPatterns?.length > 0" class="manifest-patterns">
                  {{ detail.ignoreSnapshot.customPatterns.join('、') }}
                </span>
                <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
      <div class="dialog-footer">
        <button class="btn-cancel" @click="$emit('close')">
          {{ t('components.settings.checkpoint.sections.cleanup.manifestClose') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* EX-11: 排除清单详情对话框 */
.manifest-overlay {
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

.manifest-dialog {
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  width: 460px;
  max-width: 92%;
  max-height: 80vh;
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

.dialog-header .codicon-filter {
  color: var(--vscode-descriptionForeground);
  font-size: 16px;
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

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.btn-cancel {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn-cancel:hover {
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

.manifest-body {
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.5;
}

.manifest-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}

.manifest-loading .codicon {
  color: var(--vscode-progressBar-background);
}

.manifest-error,
.manifest-unavailable {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}

.manifest-error {
  color: var(--vscode-errorForeground, #f14c4c);
}

.manifest-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.08));
  border: 1px solid var(--vscode-panel-border);
}

.manifest-stat-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.manifest-stat-value {
  font-size: 18px;
  font-weight: 600;
}

.manifest-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.manifest-rules-changed {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.12));
  border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 200, 0, 0.5));
  color: var(--vscode-inputValidation-warningForeground, #cca700);
  font-size: 12px;
}

.manifest-section-title {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.manifest-rows {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}

.manifest-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
}

.manifest-row:last-child {
  border-bottom: none;
}

.manifest-row-label {
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
}

.manifest-profiles,
.manifest-patterns {
  text-align: right;
  word-break: break-all;
  max-width: 260px;
}
</style>
