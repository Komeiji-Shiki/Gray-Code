<script setup lang="ts">
/**
 * StaticTemplateSection - 静态系统提示词编辑区（传统模板模式）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：模板内容由父组件通过 props 注入，编辑/重置通过 emit 上报，
 *   自身不持有任何响应式状态（状态仍由 PromptSettings.vue 持有）。
 */
import { t } from '@/i18n'

defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'reset'): void
}>()
</script>

<template>
  <!-- 静态系统提示词编辑区 -->
  <div class="template-section" data-search-anchor="static-prompt">
    <div class="section-header">
      <label class="section-label">
        <i class="codicon codicon-file-code"></i>
        {{ t('components.settings.promptSettings.staticSection.title') }}
        <span class="section-badge cacheable">{{ t('components.settings.promptSettings.staticModules.badge') }}</span>
      </label>
      <button class="reset-btn" @click="emit('reset')">
        <i class="codicon codicon-discard"></i>
        {{ t('components.settings.promptSettings.templateSection.resetButton') }}
      </button>
    </div>

    <p class="section-description">
      {{ t('components.settings.promptSettings.staticSection.description') }}
    </p>

    <textarea
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      class="template-textarea"
      :placeholder="t('components.settings.promptSettings.staticSection.placeholder')"
      rows="12"
    ></textarea>
  </div>
</template>

<style scoped>
.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background);
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

.section-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.section-badge.cacheable {
  background: var(--vscode-charts-green);
  color: var(--vscode-editor-background);
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.reset-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.reset-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.reset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.template-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), monospace;
  line-height: 1.5;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  resize: vertical;
  outline: none;
}

.template-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.template-textarea:disabled {
  opacity: 0.6;
}
</style>
