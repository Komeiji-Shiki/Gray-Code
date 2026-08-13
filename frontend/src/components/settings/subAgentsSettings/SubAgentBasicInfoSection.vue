<script setup lang="ts">
/**
 * SubAgentBasicInfoSection - 子代理「基本信息」区块
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：当前代理配置由父组件传入，字段更新回调由父组件提供。
 */
import { useI18n } from '@/i18n'
import { CustomCheckbox } from '../../common'
import type { SubAgentConfig } from '@/types/settingsConfig'

defineProps<{
  agent: SubAgentConfig
  onUpdateField: (field: 'description' | 'maxIterations' | 'maxRuntime' | 'enabled', value: unknown) => void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="config-section" data-search-anchor="subagents-basic-info">
    <h5>{{ t('components.settings.subagents.basicInfo') }}</h5>

    <div class="form-group">
      <label>{{ t('components.settings.subagents.description') }}</label>
      <input
        type="text"
        :value="agent.description"
        @change="onUpdateField('description', ($event.target as HTMLInputElement).value)"
        :placeholder="t('components.settings.subagents.descriptionPlaceholder')"
      />
    </div>

    <div class="form-row">
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.maxIterations') }}</label>
        <input
          type="number"
          :value="agent.maxIterations ?? 50"
          min="-1"
          @change="onUpdateField('maxIterations', parseInt(($event.target as HTMLInputElement).value) || 50)"
        />
        <span class="field-hint">{{ t('components.settings.subagents.maxIterationsHint') }}</span>
      </div>

      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.maxRuntime') }}</label>
        <input
          type="number"
          :value="agent.maxRuntime ?? 1800"
          min="-1"
          @change="onUpdateField('maxRuntime', parseInt(($event.target as HTMLInputElement).value) || 1800)"
        />
        <span class="field-hint">{{ t('components.settings.subagents.maxRuntimeHint') }}</span>
      </div>
    </div>

    <div class="form-group">
      <CustomCheckbox
        :modelValue="agent.enabled !== false"
        :label="t('components.settings.subagents.enabled')"
        @update:modelValue="onUpdateField('enabled', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.config-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-section h5 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.form-group input,
.form-group textarea {
  padding: 6px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.field-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

/* Agent 配置中的数字输入框 */
.config-section input[type="number"] {
  width: 120px;
}
</style>
