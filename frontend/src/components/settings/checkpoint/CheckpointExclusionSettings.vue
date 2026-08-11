<script setup lang="ts">
/**
 * CheckpointExclusionSettings - 排除配置区（EX-08 / EX-09）
 *
 * 从 CheckpointSettings.vue 模板拆分（C3 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：状态与动作全部由父组件通过 props/emits 注入（状态仍归父组件的
 *   useCheckpointConfig / useCheckpointExclusion 单一实例持有），自身不持有任何响应式状态。
 * - editingProfileId / profilePatternsDraft 通过 v-model 协议回写父组件 ref。
 */
import { CustomCheckbox, PatternListEditor } from '../../common'
import { t } from '@/i18n'
import type { ExclusionPreviewResult } from '@/stores/chat/checkpointActions'

defineProps<{
  configEnabled: boolean
  configSaveError: string | null
  defaultProfileIds: readonly string[]
  isProfileEnabled: (profileId: string) => boolean
  toggleProfile: (profileId: string, enabled: boolean) => void
  openProfileEditor: (profileId: string) => void
  saveProfilePatterns: (profileId: string) => void
  profileLabel: (profileId: string) => string
  profilePatterns: (profileId: string) => string[]
  editingProfileId: string | null
  profilePatternsDraft: string[]
  maxFileSizeDraft: string
  handleMaxFileSizeInput: (event: Event) => void
  handleMaxFileSizeChange: () => void
  maxFileSizeError: string | null
  customPatterns: string[]
  onCustomPatternsChange: (next: string[]) => void
  isPreviewing: boolean
  runPreview: () => void
  previewError: string | null
  previewResult: ExclusionPreviewResult | null
  previewRows: Array<{ key: string; label: string; summary: ExclusionPreviewResult['summary'] }>
  togglePreviewProfile: (key: string) => void
  expandedPreviewProfile: string | null
  reasonLabel: (reason: string) => string
  formatSize: (size: number) => string
}>()

defineEmits<{
  (e: 'update:editingProfileId', value: string | null): void
  (e: 'update:profilePatternsDraft', value: string[]): void
}>()
</script>

<template>
  <!-- 排除配置（EX-08 / EX-09） -->
  <div class="setting-group" :class="{ disabled: !configEnabled }" data-search-anchor="checkpoint-exclusions">
    <h4 class="group-title">
      <i class="codicon codicon-filter"></i>
      {{ t('components.settings.checkpoint.sections.exclusion.title') }}
    </h4>
    <p class="setting-description">
      {{ t('components.settings.checkpoint.sections.exclusion.description') }}
    </p>

    <!-- 保存错误提示（EX-12 校验拒绝等） -->
    <div v-if="configSaveError" class="exclusion-error">
      <i class="codicon codicon-warning"></i>
      <span>{{ configSaveError }}</span>
    </div>

    <!-- 默认排除类别开关（每类别可编辑模式清单） -->
    <div
      v-for="profileId in defaultProfileIds"
      :key="profileId"
      class="profile-row"
    >
      <CustomCheckbox
        :modelValue="isProfileEnabled(profileId)"
        :label="profileLabel(profileId)"
        :disabled="!configEnabled"
        @update:modelValue="(v: boolean) => toggleProfile(profileId, v)"
      />
      <div class="profile-row-actions">
        <span class="profile-patterns" :title="profilePatterns(profileId).join('\n')">
          {{ profilePatterns(profileId).length }} {{ t('components.settings.checkpoint.sections.exclusion.patterns') }}
        </span>
        <button
          class="profile-edit-btn"
          :disabled="!configEnabled"
          @click="openProfileEditor(profileId)"
        >
          <i class="codicon codicon-edit"></i>
          {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.edit') }}
        </button>
      </div>
    </div>

    <!-- 类别模式编辑面板 -->
    <div v-if="editingProfileId" class="profile-edit-panel">
      <div class="profile-edit-header">
        <span class="profile-edit-title">
          <i class="codicon codicon-pencil"></i>
          {{ profileLabel(editingProfileId) }}
        </span>
        <button
          class="profile-edit-clear"
          :disabled="!configEnabled"
          @click="$emit('update:profilePatternsDraft', [])"
        >
          {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.clear') }}
        </button>
      </div>
      <PatternListEditor
        :model-value="profilePatternsDraft"
        :disabled="!configEnabled"
        :placeholder="t('components.settings.checkpoint.sections.exclusion.profilePatterns.placeholder')"
        :empty-text="t('components.settings.checkpoint.sections.exclusion.profilePatterns.empty')"
        :add-label="t('components.settings.checkpoint.sections.exclusion.patternsAdd')"
        @update:model-value="$emit('update:profilePatternsDraft', $event)"
      />
      <div class="profile-edit-actions">
        <button
          class="profile-edit-save"
          @click="saveProfilePatterns(editingProfileId)"
        >
          {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.save') }}
        </button>
        <button class="profile-edit-cancel" @click="$emit('update:editingProfileId', null)">
          {{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.cancel') }}
        </button>
        <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.profilePatterns.hint') }}</span>
      </div>
    </div>

    <!-- 单文件大小上限 -->
    <div class="form-row">
      <label>{{ t('components.settings.checkpoint.sections.exclusion.maxFileSize.label') }}</label>
      <input
        type="text"
        :value="maxFileSizeDraft"
        @input="handleMaxFileSizeInput"
        @change="handleMaxFileSizeChange"
        :disabled="!configEnabled"
        class="number-input"
        placeholder="50"
      />
      <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.maxFileSize.hint') }}</span>
      <span v-if="maxFileSizeError" class="exclusion-error">
        <i class="codicon codicon-warning"></i>
        <span>{{ maxFileSizeError }}</span>
      </span>
    </div>

    <!-- 自定义排除模式 -->
    <div class="form-row patterns-row">
      <label>
        {{ t('components.settings.checkpoint.sections.exclusion.customPatterns.label') }}
        <span class="pattern-count">{{ customPatterns.length }}</span>
      </label>
      <PatternListEditor
        :model-value="customPatterns"
        :disabled="!configEnabled"
        :placeholder="t('components.settings.checkpoint.sections.exclusion.customPatterns.placeholder')"
        :empty-text="t('components.settings.checkpoint.sections.exclusion.customPatterns.empty')"
        :add-label="t('components.settings.checkpoint.sections.exclusion.patternsAdd')"
        @update:model-value="onCustomPatternsChange"
      />
      <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.customPatterns.hint') }}</span>
      <!-- M-5: 目录型默认类别需同时否定目录本身才能重新纳入其下文件 -->
      <span class="hint">{{ t('components.settings.checkpoint.sections.exclusion.customPatterns.reincludeHint') }}</span>
    </div>

    <!-- 预览排除结果 -->
    <div class="preview-bar">
      <button
        class="preview-btn"
        :disabled="isPreviewing || !configEnabled"
        @click="runPreview"
      >
        <i
          class="codicon"
          :class="isPreviewing ? 'codicon-loading codicon-modifier-spin' : 'codicon-search'"
        ></i>
        {{ isPreviewing
          ? t('components.settings.checkpoint.sections.exclusion.preview.loading')
          : t('components.settings.checkpoint.sections.exclusion.preview.button') }}
      </button>
    </div>

    <div v-if="previewError" class="exclusion-error">
      <i class="codicon codicon-warning"></i>
      <span>{{ previewError }}</span>
    </div>

    <div v-if="previewResult" class="preview-result">
      <div class="preview-total">
        <i class="codicon codicon-database"></i>
        {{ t('components.settings.checkpoint.sections.exclusion.preview.total', {
          count: previewResult.summary.excludedCount,
          size: formatSize(previewResult.summary.excludedBytes)
        }) }}
        <span v-if="!previewResult.complete" class="preview-partial">
          {{ t('components.settings.checkpoint.sections.exclusion.preview.partial') }}
        </span>
      </div>

      <div v-if="previewRows.length === 0" class="preview-empty">
        {{ t('components.settings.checkpoint.sections.exclusion.preview.empty') }}
      </div>

      <div
        v-for="row in previewRows"
        :key="row.key"
        class="preview-row"
      >
        <button
          class="preview-row-header"
          @click="togglePreviewProfile(row.key)"
        >
          <i
            class="codicon"
            :class="expandedPreviewProfile === row.key ? 'codicon-chevron-down' : 'codicon-chevron-right'"
          ></i>
          <span class="preview-row-label">{{ row.label }}</span>
          <span class="preview-row-stats">
            {{ t('components.settings.checkpoint.sections.exclusion.preview.count', { count: row.summary.excludedCount }) }}
            · {{ formatSize(row.summary.excludedBytes) }}
          </span>
        </button>

        <div v-if="expandedPreviewProfile === row.key" class="preview-samples">
          <div
            v-for="sample in row.summary.samples"
            :key="sample.path"
            class="preview-sample"
          >
            <div class="sample-path">{{ sample.path }}</div>
            <div class="sample-meta">
              <span class="sample-reason">{{ reasonLabel(sample.reason) }}</span>
              <span v-if="sample.rule" class="sample-rule">
                {{ t('components.settings.checkpoint.sections.exclusion.preview.rule') }}: {{ sample.rule }}
              </span>
              <span v-if="sample.source" class="sample-source">
                {{ t('components.settings.checkpoint.sections.exclusion.preview.source') }}: {{ sample.source }}
              </span>
              <span v-if="sample.size" class="sample-size">{{ formatSize(sample.size) }}</span>
            </div>
          </div>
          <div v-if="row.summary.samples.length === 0" class="preview-no-samples">
            {{ t('components.settings.checkpoint.sections.exclusion.preview.noSamples') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 设置组 */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity 0.2s;
}

.setting-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.group-title .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.setting-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 表单行 */
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-row label {
  font-size: 12px;
  font-weight: 500;
}

.number-input {
  width: 100px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
}

.number-input:focus {
  border-color: var(--vscode-focusBorder);
}

.number-input:disabled {
  opacity: 0.6;
}

.hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ========== 排除配置（EX-08 / EX-09） ========== */
.profile-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

/* 右侧操作列：规则计数 + 编辑按钮整体右对齐，计数紧贴按钮左侧，不再随行漂移居中 */
.profile-row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.profile-patterns {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

.profile-edit-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.profile-edit-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.profile-edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.patterns-row {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}

.pattern-count {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  margin-left: 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background, rgba(128, 128, 128, 0.25));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  font-size: 10px;
  font-weight: 500;
  vertical-align: middle;
}

/* 类别模式编辑面板 */
.profile-edit-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.profile-edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.profile-edit-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-edit-clear {
  flex-shrink: 0;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.profile-edit-clear:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.profile-edit-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.profile-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile-edit-save,
.profile-edit-cancel {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.profile-edit-save {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.profile-edit-save:hover {
  background: var(--vscode-button-hoverBackground);
}

.profile-edit-cancel {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.profile-edit-cancel:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.exclusion-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
  border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
  color: var(--vscode-errorForeground, #f14c4c);
  font-size: 12px;
  word-break: break-all;
}

.preview-bar {
  margin-top: 10px;
}

.preview-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  font-size: 12px;
}

.preview-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.preview-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.preview-result {
  margin-top: 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  border-radius: 4px;
  overflow: hidden;
}

.preview-total {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.1));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
}

.preview-partial {
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
}

.preview-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.preview-row {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
}

.preview-row:last-child {
  border-bottom: none;
}

.preview-row-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.preview-row-header:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
}

.preview-row-label {
  flex: 1;
}

.preview-row-stats {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  white-space: nowrap;
}

.preview-samples {
  padding: 2px 10px 8px 26px;
}

.preview-sample {
  padding: 4px 0;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
  font-size: 12px;
}

.preview-sample:last-child {
  border-bottom: none;
}

.sample-path {
  word-break: break-all;
}

.sample-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.sample-reason {
  color: var(--vscode-charts-yellow, #cca700);
}

.preview-no-samples {
  padding: 6px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
