<script setup lang="ts">
/**
 * SubAgentBasicInfoSection - 子代理「基本信息」区块
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：当前代理配置由父组件传入，字段更新回调由父组件提供。
 */
import { ref } from 'vue'
import { useI18n } from '@/i18n'
import { CustomCheckbox } from '../../common'
import type { SubAgentConfig } from '@/types/settingsConfig'

const props = defineProps<{
  agent: SubAgentConfig
  defaultMaxIterations: number
  defaultMaxRuntimeSeconds: number
  onUpdateField: (field: 'description' | 'maxIterations' | 'maxRuntime' | 'enabled', value: unknown) => void
}>()

const { t } = useI18n()
const limitErrors = ref<Partial<Record<'maxIterations' | 'maxRuntime', string>>>({})

function updateLimit(field: 'maxIterations' | 'maxRuntime', event: Event) {
  const raw = (event.target as HTMLInputElement).value.trim()
  const value = raw === '' ? null : Number(raw)
  if (value !== null && (!Number.isSafeInteger(value) || (value !== -1 && value < 1))) {
    limitErrors.value[field] = t('components.settings.subagents.queueTimeoutSecondsInvalid')
    return
  }
  delete limitErrors.value[field]
  // null 明确撤销单独配置；省略字段则表示此次没有修改。
  props.onUpdateField(field, value)
}
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
          :value="agent.maxIterations ?? ''"
          :aria-label="t('components.settings.subagents.maxIterations')"
          :placeholder="t('components.settings.subagents.inheritedLimit', { value: defaultMaxIterations })"
          min="-1"
          @change="updateLimit('maxIterations', $event)"
        />
        <span class="field-hint">{{ t('components.settings.subagents.maxIterationsHint') }}</span>
        <span class="field-hint">{{ t('components.settings.subagents.inheritLimitHint', { value: defaultMaxIterations }) }}</span>
        <span v-if="limitErrors.maxIterations" class="limit-error" role="alert">{{ limitErrors.maxIterations }}</span>
      </div>

      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.maxRuntime') }}</label>
        <input
          type="number"
          :value="agent.maxRuntime ?? ''"
          :aria-label="t('components.settings.subagents.maxRuntime')"
          :placeholder="t('components.settings.subagents.inheritedLimit', { value: defaultMaxRuntimeSeconds })"
          min="-1"
          @change="updateLimit('maxRuntime', $event)"
        />
        <span class="field-hint">{{ t('components.settings.subagents.maxRuntimeHint') }}</span>
        <span class="field-hint">{{ t('components.settings.subagents.inheritLimitHint', { value: defaultMaxRuntimeSeconds }) }}</span>
        <span v-if="limitErrors.maxRuntime" class="limit-error" role="alert">{{ limitErrors.maxRuntime }}</span>
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
  border-radius: 0;
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
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

/* Agent 配置中的数字输入框 */
.config-section input[type="number"] {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.limit-error { color: var(--vscode-errorForeground); font-size: 12px; }
</style>
