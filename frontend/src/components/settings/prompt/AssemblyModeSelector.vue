<script setup lang="ts">
/**
 * AssemblyModeSelector - 提示词组装方式选择区（传统模板 / 预设条目）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：选中值由父组件通过 props 注入，变更通过 emit 上报，
 *   自身不持有任何响应式状态（状态仍由 PromptSettings.vue 持有）。
 */
import { t } from '@/i18n'
import type { PromptAssemblyMode } from './types'

defineProps<{
  modelValue: PromptAssemblyMode
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: PromptAssemblyMode): void
}>()
</script>

<template>
  <!-- 提示词组装方式 -->
  <div class="template-section assembly-section" data-search-anchor="prompt-assembly">
    <div class="section-header">
      <label class="section-label">
        <i class="codicon codicon-settings-gear"></i>
        {{ t('components.settings.promptSettings.assemblyMode.title') }}
      </label>
    </div>
    <p class="section-description">
      {{ t('components.settings.promptSettings.assemblyMode.description') }}
    </p>
    <div class="assembly-options">
      <label class="radio-option assembly-option">
        <input
          type="radio"
          value="legacy"
          :checked="modelValue === 'legacy'"
          @change="emit('update:modelValue', 'legacy')"
        />
        <span class="radio-text">{{ t('components.settings.promptSettings.assemblyMode.legacyLabel') }}</span>
        <span class="assembly-option-desc">{{ t('components.settings.promptSettings.assemblyMode.legacyDescription') }}</span>
      </label>
      <label class="radio-option assembly-option">
        <input
          type="radio"
          value="entries"
          :checked="modelValue === 'entries'"
          @change="emit('update:modelValue', 'entries')"
        />
        <span class="radio-text">{{ t('components.settings.promptSettings.assemblyMode.entriesLabel') }}</span>
        <span class="assembly-option-desc">{{ t('components.settings.promptSettings.assemblyMode.entriesDescription') }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.radio-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.radio-option input {
  margin: 0;
}

.assembly-section {
  border-color: var(--vscode-button-background);
}

.assembly-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}

.assembly-option {
  align-items: flex-start;
  padding: 10px 12px;
  background: var(--vscode-sideBar-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.assembly-option .radio-text {
  font-weight: 600;
}

.assembly-option-desc {
  color: var(--vscode-descriptionForeground);
  line-height: 1.45;
}
</style>
