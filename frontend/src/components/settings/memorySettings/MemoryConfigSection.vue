<script setup lang="ts">
/**
 * MemoryConfigSection - 记忆提示词 & 运行时参数配置区块
 *
 * 从 MemorySettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：开关 / 提示词 / 运行时参数 / 保存状态均由父组件注入，自身不持有业务状态；
 * - 数字输入沿用 v-model.number 语义（computed 读写代理），保存/重置/刷新通过 emits 回传父组件。
 */
import { computed } from 'vue'
import { CustomCheckbox } from '../../common'
import { useI18n } from '@/i18n'

const { t } = useI18n()

const props = defineProps<{
  enabled: boolean
  systemPrompt: string
  wakeLines: number
  entryChars: number
  partChars: number
  partLines: number
  isSaving: boolean
  statusMessage: string
  statusError: boolean
  memoryScope: 'global' | 'workspace'
  entriesLoading: boolean
}>()

const emit = defineEmits<{
  (e: 'update:enabled', value: boolean): void
  (e: 'update:systemPrompt', value: string): void
  (e: 'update:wakeLines', value: number): void
  (e: 'update:entryChars', value: number): void
  (e: 'update:partChars', value: number): void
  (e: 'update:partLines', value: number): void
  (e: 'save'): void
  (e: 'reset'): void
  (e: 'refresh'): void
}>()

// 数字输入框的 v-model.number 代理（getter 读 props，setter 回写父组件）
const wakeLinesModel = computed({ get: () => props.wakeLines, set: (v: number) => emit('update:wakeLines', v) })
const entryCharsModel = computed({ get: () => props.entryChars, set: (v: number) => emit('update:entryChars', v) })
const partCharsModel = computed({ get: () => props.partChars, set: (v: number) => emit('update:partChars', v) })
const partLinesModel = computed({ get: () => props.partLines, set: (v: number) => emit('update:partLines', v) })
</script>

<template>
  <!-- 长期记忆总开关 -->
  <div class="section memory-toggle-section" data-search-anchor="memory-toggle">
    <CustomCheckbox
      :model-value="enabled"
      :label="t('components.settings.settingsPanel.memory.enabled.label')"
      :hint="t('components.settings.settingsPanel.memory.enabled.description')"
      :disabled="memoryScope === 'workspace'"
      @update:model-value="emit('update:enabled', $event)"
    />
    <p v-if="!enabled" class="disabled-notice">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.memory.enabled.disabledNotice') }}
    </p>
    <!-- LOW-9：enabled 是全局配置，工作区 tab 下后端不持久化该字段——
         禁用并说明，避免用户以为改动了实际被静默丢弃 -->
    <p v-if="memoryScope === 'workspace'" class="disabled-notice">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.memory.globalOnlyHint') }}
    </p>
  </div>

  <!-- 自定义提示词 -->
  <div class="form-group" data-search-anchor="memory-custom-prompt">
    <label class="group-label">
      <i class="codicon codicon-note"></i>
      {{ t('components.settings.settingsPanel.memory.systemPrompt.title') }}
    </label>
    <p class="field-description">
      {{ t('components.settings.settingsPanel.memory.systemPrompt.description') }}
    </p>
    <textarea
      :value="systemPrompt"
      class="form-textarea"
      rows="16"
      :disabled="!enabled || memoryScope === 'workspace'"
      @input="emit('update:systemPrompt', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <!-- LOW-9：systemPrompt 是全局配置，工作区 tab 下后端不持久化该字段 -->
    <p v-if="memoryScope === 'workspace'" class="disabled-notice">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.memory.globalOnlyHint') }}
    </p>
  </div>

  <!-- 运行时参数 -->
  <div class="section" data-search-anchor="memory-runtime">
    <h5 class="section-title">
      <i class="codicon codicon-settings-gear"></i>
      {{ t('components.settings.settingsPanel.memory.runtime.title') }}
    </h5>
    <p class="field-description" style="margin-bottom: 12px;">
      {{ t('components.settings.settingsPanel.memory.runtime.description') }}
    </p>

    <div class="params-grid">
      <div class="form-group">
        <label class="param-label">
          {{ t('components.settings.settingsPanel.memory.runtime.wakeLines.label') }}
        </label>
        <p class="field-description">
          {{ t('components.settings.settingsPanel.memory.runtime.wakeLines.description') }}
        </p>
        <div class="number-input-row">
          <input type="number" v-model.number="wakeLinesModel" min="1" max="500" class="form-input-number" :disabled="!enabled" />
          <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.wakeLines.unit') }}</span>
        </div>
      </div>
      <div class="form-group">
        <label class="param-label">
          {{ t('components.settings.settingsPanel.memory.runtime.entryChars.label') }}
        </label>
        <p class="field-description">
          {{ t('components.settings.settingsPanel.memory.runtime.entryChars.description') }}
        </p>
        <div class="number-input-row">
          <input type="number" v-model.number="entryCharsModel" min="1" max="1000" class="form-input-number" :disabled="!enabled" />
          <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.entryChars.unit') }}</span>
        </div>
      </div>
      <div class="form-group">
        <label class="param-label">
          {{ t('components.settings.settingsPanel.memory.runtime.partChars.label') }}
        </label>
        <p class="field-description">
          {{ t('components.settings.settingsPanel.memory.runtime.partChars.description') }}
        </p>
        <div class="number-input-row">
          <input type="number" v-model.number="partCharsModel" min="100" max="100000" step="100" class="form-input-number" :disabled="!enabled" />
          <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.partChars.unit') }}</span>
        </div>
      </div>
      <div class="form-group">
        <label class="param-label">
          {{ t('components.settings.settingsPanel.memory.runtime.partLines.label') }}
        </label>
        <p class="field-description">
          {{ t('components.settings.settingsPanel.memory.runtime.partLines.description') }}
        </p>
        <div class="number-input-row">
          <input type="number" v-model.number="partLinesModel" min="10" max="2000" step="10" class="form-input-number" :disabled="!enabled" />
          <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.partLines.unit') }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 操作按钮 -->
  <div class="form-actions">
    <button class="btn btn-primary" @click="emit('save')" :disabled="isSaving">
      <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
      <i v-else class="codicon codicon-save"></i>
      {{ isSaving ? t('components.settings.settingsPanel.memory.saving') : t('components.settings.settingsPanel.memory.save') }}
    </button>
    <button class="btn btn-secondary" @click="emit('reset')">
      <i class="codicon codicon-discard"></i>
      {{ t('components.settings.settingsPanel.memory.reset') }}
    </button>
    <button class="btn btn-secondary" @click="emit('refresh')" :disabled="entriesLoading">
      <i :class="entriesLoading ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-refresh'"></i>
      {{ t('common.refresh') }}
    </button>
  </div>

  <!-- 状态消息 -->
  <div v-if="statusMessage" class="status-message" :class="{ 'status-error': statusError }">
    {{ statusMessage }}
  </div>
</template>

<style scoped>
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-label {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.group-label i {
  font-size: 14px;
}

.field-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 0;
}

.form-textarea {
  width: 100%;
  min-height: 200px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  resize: vertical;
  line-height: 1.5;
}

.form-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.form-textarea:disabled,
.form-input-number:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.memory-toggle-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.disabled-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.5;
}

.disabled-notice i {
  margin-top: 2px;
  flex-shrink: 0;
}

/* 分区 */
.section {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 14px 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 6px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-foreground);
}

.section-title i {
  font-size: 13px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 9px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  margin-left: 4px;
}

/* 参数网格 */
.params-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.param-label {
  font-size: 12px;
  font-weight: 500;
}

.number-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-input-number {
  flex: 1;
  padding: 5px 8px;
  font-size: 13px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  appearance: textfield;
}

.form-input-number::-webkit-outer-spin-button,
.form-input-number::-webkit-inner-spin-button {
  appearance: none;
}

.form-input-number:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.unit {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

/* 按钮 */
.form-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.btn {
  padding: 6px 14px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: opacity 0.15s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn i {
  font-size: 13px;
}

.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.btn-secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.status-message {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-infoBackground);
  color: var(--vscode-inputValidation-infoForeground);
  border: 1px solid var(--vscode-inputValidation-infoBorder);
}

.status-error {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder);
}
</style>
