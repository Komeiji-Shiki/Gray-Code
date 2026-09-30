<script setup lang="ts">
/**
 * DynamicTemplateSection - 动态上下文模板编辑区（含启用开关与保留策略内联区块，传统模板模式）
 *
 * 从 PromptSettings.vue 模板拆分（S6 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：模板/开关/策略值由父组件通过 props 注入，编辑与重置通过 emit 上报，
 *   自身不持有任何响应式状态（状态仍由 PromptSettings.vue 持有）。
 */
import { t } from '@/i18n'
import DynamicStrategyBlock from './DynamicStrategyBlock.vue'
import type { DynamicContextStrategy } from './types'

defineProps<{
  modelValue: string
  enabled: boolean
  strategy: DynamicContextStrategy
  formatModuleId: (id: string) => string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'update:enabled', value: boolean): void
  (event: 'update:strategy', value: DynamicContextStrategy): void
  (event: 'reset'): void
}>()
</script>

<template>
  <!-- 动态上下文模板编辑区 -->
  <div class="template-section dynamic-section" data-search-anchor="dynamic-context">
    <div class="section-header">
      <label class="section-label">
        <i class="codicon codicon-sync"></i>
        {{ t('components.settings.promptSettings.dynamicSection.title') }}
        <span class="section-badge realtime">{{ t('components.settings.promptSettings.dynamicModules.badge') }}</span>
      </label>
      <div class="section-header-actions">
        <!-- 启用开关 -->
        <label class="toggle-switch" :title="t('components.settings.promptSettings.dynamicSection.enableTooltip')">
          <input
            type="checkbox"
            :checked="enabled"
            @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-slider"></span>
        </label>
        <button class="reset-btn" @click="emit('reset')" :disabled="!enabled">
          <i class="codicon codicon-discard"></i>
          {{ t('components.settings.promptSettings.templateSection.resetButton') }}
        </button>
      </div>
    </div>

    <p class="section-description">
      {{ t('components.settings.promptSettings.dynamicSection.description') }}
    </p>

    <!-- 禁用时显示提示 -->
    <div v-if="!enabled" class="disabled-notice">
      <i class="codicon codicon-info"></i>
      <span>{{ t('components.settings.promptSettings.dynamicSection.disabledNotice') }}</span>
    </div>

    <textarea
      v-else
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      class="template-textarea"
      :placeholder="t('components.settings.promptSettings.dynamicSection.placeholder')"
      rows="10"
    ></textarea>

    <!-- 动态上下文保留策略（传统模板模式） -->
    <div class="dynamic-strategy-inline">
      <div class="section-label">
        <i class="codicon codicon-history"></i>
        {{ t('components.settings.promptSettings.dynamicSection.strategyTitle') }}
      </div>

      <DynamicStrategyBlock
        :model-value="strategy"
        :format-module-id="formatModuleId"
        @update:model-value="emit('update:strategy', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
}

.template-section.dynamic-section {
  border-color: var(--gc-chart-blue);
  border-style: dashed;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
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
  border-radius: var(--gc-radius-md);
  font-weight: 500;
}

.section-badge.realtime {
  background: var(--gc-chart-blue);
  color: var(--gc-surface-base);
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--gc-text-muted);
}

.reset-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  cursor: pointer;
  transition: background-color 0.15s;
}

.reset-btn:hover:not(:disabled) {
  background: var(--gc-surface-hover);
}

.reset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.template-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-family: var(--gc-font-code), monospace;
  line-height: 1.5;
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  resize: vertical;
  outline: none;
}

.template-textarea:focus {
  border-color: var(--gc-focus-border);
}

.template-textarea:disabled {
  opacity: 0.6;
}

/* 动态上下文保留策略（内嵌于动态模板卡片） */
.dynamic-strategy-inline {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--gc-border-subtle);
}

.dynamic-strategy-inline .section-label {
  font-size: 12px;
  margin-bottom: 8px;
}

/* 开关样式 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--gc-surface-input);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-md);
  transition: 0.2s;
}

.toggle-slider::before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: var(--gc-text-primary);
  border-radius: var(--gc-radius-xs);
  transition: 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--gc-button-primary);
  border-color: var(--gc-button-primary);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background-color: var(--gc-text-on-primary);
}

.toggle-switch:hover input:not(:disabled) + .toggle-slider,
.toggle-switch input:focus + .toggle-slider {
  border-color: var(--gc-focus-border);
}

/* 禁用提示 */
.disabled-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--gc-info-bg);
  border: 1px solid var(--gc-info-border);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  color: var(--gc-text-primary);
}

.disabled-notice .codicon {
  color: var(--gc-info);
}
</style>
