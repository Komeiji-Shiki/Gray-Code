<script setup lang="ts">
/**
 * DynamicStrategyBlock - 动态上下文保留策略块（single / preserve 单选 + 说明 + 警告）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：选中值与 formatModuleId 由父组件通过 props 注入，变更通过 emit 上报；
 *   本块同时用于「预设条目」模式下的独立区块与「传统模板」模式下的内联区块。
 */
import { t } from '@/i18n'
import type { DynamicContextStrategy } from './types'

defineProps<{
  modelValue: DynamicContextStrategy
  formatModuleId: (id: string) => string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: DynamicContextStrategy): void
}>()
</script>

<template>
  <div class="dynamic-strategy-block">
    <div class="dynamic-strategy-options">
      <label class="radio-option">
        <input type="radio" value="single" :checked="modelValue === 'single'" @change="emit('update:modelValue', 'single')" />
        <span class="radio-text">{{ t('components.settings.promptSettings.dynamicSection.strategySingle') }}</span>
      </label>
      <label class="radio-option">
        <input type="radio" value="preserve" :checked="modelValue === 'preserve'" @change="emit('update:modelValue', 'preserve')" />
        <span class="radio-text">{{ t('components.settings.promptSettings.dynamicSection.strategyPreserve') }}</span>
      </label>
    </div>
    <p class="dynamic-strategy-description">
      {{ t('components.settings.promptSettings.dynamicSection.strategyVarsPrefix') }}
      <code>{{ formatModuleId('WORKSPACE_FILES') }}</code>{{ t('components.settings.promptSettings.dynamicSection.strategyVarsSeparator') }}
      <code>{{ formatModuleId('DIAGNOSTICS') }}</code>{{ t('components.settings.promptSettings.dynamicSection.strategyVarsSeparator') }}
      <code>{{ formatModuleId('TODO_LIST') }}</code>
      {{ t('components.settings.promptSettings.dynamicSection.strategyVarsSuffix') }}
    </p>
    <p v-if="modelValue === 'preserve'" class="dynamic-strategy-warning">
      <i class="codicon codicon-warning"></i>
      {{ t('components.settings.promptSettings.dynamicSection.strategyVarsWarning') }}
    </p>
  </div>
</template>

<style scoped>
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

.dynamic-strategy-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin: 10px 0;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 4px;
}

.dynamic-strategy-options {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.dynamic-strategy-description,
.dynamic-strategy-warning {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
}

.dynamic-strategy-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
}
</style>
