<script setup lang="ts">
import { computed } from 'vue'
import { CustomSelect, CustomSwitch, type SelectOption } from '../../common'
import { useI18n } from '../../../i18n'
import { useDeferredNumberInput } from '../../../composables/useDeferredNumberInput'
import { useChannelOptions } from './useChannelOptions'

const { t } = useI18n()

const props = defineProps<{
  config: any
}>()

const emit = defineEmits<{
  (e: 'update:option', optionKey: string, value: any): void
  (e: 'update:optionEnabled', optionKey: string, enabled: boolean, optionValue?: any): void
  (e: 'update:field', field: string, value: any): void
}>()

// 草稿模式：清空后不立即回填 -1；离开设置页时自动回填已保存值
const {
  draft: historyThinkingRoundsDraft,
  handleInput: handleHistoryThinkingRoundsInput
} = useDeferredNumberInput(() => props.config?.historyThinkingRounds ?? -1)

// 思考强度选项
const effortOptions = computed<SelectOption[]>(() => [
  { value: 'none', label: t('components.channels.openai-responses.thinking.effortNone'), description: '' },
  { value: 'minimal', label: t('components.channels.openai-responses.thinking.effortMinimal'), description: '' },
  { value: 'low', label: t('components.channels.openai-responses.thinking.effortLow'), description: '' },
  { value: 'medium', label: t('components.channels.openai-responses.thinking.effortMedium'), description: '' },
  { value: 'high', label: t('components.channels.openai-responses.thinking.effortHigh'), description: '' },
  { value: 'xhigh', label: t('components.channels.openai-responses.thinking.effortXHigh'), description: '' },
  { value: 'max', label: t('components.channels.openai-responses.thinking.effortMax'), description: '' },
  { value: 'ultra', label: t('components.channels.openai-responses.thinking.effortUltra'), description: '' },
  { value: 'custom', label: t('components.channels.openai-responses.thinking.effortCustom'), description: '' }
])

// 输出详细程度选项
const summaryOptions = computed<SelectOption[]>(() => [
  { value: 'auto', label: t('components.channels.openai-responses.thinking.summaryAuto'), description: '' },
  { value: 'concise', label: t('components.channels.openai-responses.thinking.summaryConcise'), description: '' },
  { value: 'detailed', label: t('components.channels.openai-responses.thinking.summaryDetailed'), description: '' }
])

const reasoningSignatureModeOptions = computed<SelectOption[]>(() => [
  {
    value: 'official',
    label: t('components.channels.openai-responses.reasoningSignatureMode.official'),
    description: t('components.channels.openai-responses.reasoningSignatureMode.officialDescription')
  },
  {
    value: 'codex',
    label: t('components.channels.openai-responses.reasoningSignatureMode.codex'),
    description: t('components.channels.openai-responses.reasoningSignatureMode.codexDescription')
  },
  {
    value: 'deepseek',
    label: t('components.channels.openai-responses.reasoningSignatureMode.deepseek'),
    description: t('components.channels.openai-responses.reasoningSignatureMode.deepseekDescription')
  }
])

// 默认配置值
const DEFAULT_VALUES: Record<string, any> = {
  temperature: 1.0,
  max_output_tokens: 8192,
  reasoning: {
    effort: 'high',
    summaryEnabled: false,
    summary: 'auto'
  }
}

const {
  isOptionEnabled, handleOptionEnabledChange, getNestedOptionValue, updateNestedOption, handleNumberChange
} = useChannelOptions(() => props.config, DEFAULT_VALUES, {
  option: (key, value) => emit('update:option', key, value),
  enabled: (key, enabled, ...values) => emit('update:optionEnabled', key, enabled, ...values)
})

// 获取思考配置字段值
function getReasoningValue(field: string, defaultValue: any = undefined): any {
  return getNestedOptionValue('reasoning', field, defaultValue)
}

// 更新思考配置字段
function updateReasoning(field: string, value: any) {
  updateNestedOption('reasoning', field, value)
}

// Responses 渠道的 reasoning item 回传不区分「当前/历史」轮次，
// 把两个签名开关合并为一个：同时更新 current 与 history 两个字段，
// 后端 MessageBuilderService 对 Responses 也按 history 开关统一处理。
function onSendThoughtSignaturesChange(e: any) {
  const value = e.target.checked
  emit('update:field', 'sendHistoryThoughtSignatures', value)
  emit('update:field', 'sendCurrentThoughtSignatures', value)
}

function onReasoningSignatureModeChange(value: string) {
  if (value === 'official' || value === 'codex' || value === 'deepseek') {
    emit('update:field', 'reasoningSignatureMode', value)
  }
}
</script>

<template>
  <div class="openai-responses-options">
    <div v-for="option in [
      { field: 'responsesWebSocketEnabled', key: 'websocket' },
      { field: 'responsesAsyncToolsEnabled', key: 'asyncTools' }
    ]" :key="option.field" class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">{{ t(`desktop.responsesNative.${option.key}.title`) }}</span>
        <CustomSwitch
          compact
          :model-value="config[option.field] === true"
          :title="t(`desktop.responsesNative.${option.key}.title`)"
          :aria-label="t(`desktop.responsesNative.${option.key}.title`)"
          @update:model-value="(value: boolean) => emit('update:field', option.field, value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t(`desktop.responsesNative.${option.key}.hint`) }}</span>
      </div>
    </div>
    <!-- Prompt Cache Key（会话缓存透传） -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-history"></i>
          {{ t('components.channels.openai-responses.promptCacheKey.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.promptCacheKeyEnabled ?? false"
          :title="t('components.channels.openai-responses.promptCacheKey.toggleHint')"
          :aria-label="t('components.channels.openai-responses.promptCacheKey.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'promptCacheKeyEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai-responses.promptCacheKey.hint') }}</span>
        <input
          type="text"
          :value="config.promptCacheKey ?? ''"
          :placeholder="t('components.channels.openai-responses.promptCacheKey.keyPlaceholder')"
          :disabled="!(config.promptCacheKeyEnabled ?? false)"
          :class="{ disabled: !(config.promptCacheKeyEnabled ?? false) }"
          @input="(e: any) => emit('update:field', 'promptCacheKey', e.target.value)"
        />
        <span class="option-hint">{{ t('components.channels.openai-responses.promptCacheKey.keyHint') }}</span>
      </div>
    </div>

    <!-- DeepSeek Vision 图片/PDF 预处理 -->
    <div v-if="config.authMode !== 'chatgpt'" class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-eye"></i>
          {{ t('components.channels.openai-responses.deepSeekVision.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.deepSeekVisionEnabled ?? false"
          :title="t('components.channels.openai-responses.deepSeekVision.toggleHint')"
          :aria-label="t('components.channels.openai-responses.deepSeekVision.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'deepSeekVisionEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai-responses.deepSeekVision.hint') }}</span>
      </div>
    </div>

    <!-- 温度 -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.common.temperature.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('temperature')"
          :title="t('components.channels.common.temperature.toggleHint')"
          :aria-label="t('components.channels.common.temperature.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('temperature', value)"
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="0"
        max="2"
        :value="config.options?.temperature"
        placeholder="1.0"
        :disabled="!isOptionEnabled('temperature')"
        :class="{ disabled: !isOptionEnabled('temperature') }"
        @input="(e: any) => handleNumberChange('temperature', e)"
      />
      <span class="option-hint">{{ t('components.channels.common.temperature.hint') }}</span>
    </div>
    
    <!-- 最大输出 Tokens -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.openai-responses.maxOutputTokens.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('max_output_tokens')"
          :title="t('components.channels.common.maxTokens.toggleHint')"
          :aria-label="t('components.channels.common.maxTokens.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('max_output_tokens', value)"
        />
      </div>
      <input
        type="number"
        :value="config.options?.max_output_tokens"
        :placeholder="t('components.channels.openai-responses.maxOutputTokens.placeholder')"
        :disabled="!isOptionEnabled('max_output_tokens')"
        :class="{ disabled: !isOptionEnabled('max_output_tokens') }"
        @input="(e: any) => handleNumberChange('max_output_tokens', e)"
      />
      <span class="option-hint">{{ t('components.channels.openai-responses.maxOutputTokens.hint') }}</span>
    </div>
    
    <!-- 思考配置 -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-lightbulb"></i>
          {{ t('components.channels.common.thinking.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('reasoning')"
          :title="t('components.channels.common.thinking.toggleHint')"
          :aria-label="t('components.channels.common.thinking.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('reasoning', value)"
        />
      </div>
      
      <div class="option-section-content" :class="{ disabled: !isOptionEnabled('reasoning') }">
        <!-- 思考强度 -->
        <div class="option-item">
          <label>{{ t('components.channels.openai-responses.thinking.effortLabel') }}</label>
          <CustomSelect
            :model-value="getReasoningValue('effort', 'high')"
            :options="effortOptions"
            :disabled="!isOptionEnabled('reasoning')"
            :placeholder="t('components.channels.openai-responses.thinking.effortPlaceholder')"
            @update:model-value="(v: string) => updateReasoning('effort', v)"
          />
          <input
            v-if="getReasoningValue('effort') === 'custom'"
            type="text"
            :value="getReasoningValue('effortCustom', '')"
            :placeholder="t('components.channels.openai-responses.thinking.effortCustomPlaceholder')"
            :disabled="!isOptionEnabled('reasoning')"
            :class="{ disabled: !isOptionEnabled('reasoning') }"
            @input="(e: any) => updateReasoning('effortCustom', e.target.value)"
          />
          <span class="option-hint">
            {{ t('components.channels.openai-responses.thinking.effortHint') }}
          </span>
        </div>

        <!-- 输出详细程度 (Summary) -->
        <div class="option-item">
          <div class="option-header">
            <label>{{ t('components.channels.openai-responses.thinking.summaryLabel') }}</label>
            <CustomSwitch
              compact
              :model-value="getReasoningValue('summaryEnabled', false)"
              :title="t('components.channels.common.thinking.toggleHint')"
              :aria-label="t('components.channels.common.thinking.toggleHint')"
              :disabled="!isOptionEnabled('reasoning')"
              @update:model-value="(value: boolean) => updateReasoning('summaryEnabled', value)"
            />
          </div>
          <CustomSelect
            :model-value="getReasoningValue('summary', 'auto')"
            :options="summaryOptions"
            :disabled="!isOptionEnabled('reasoning') || !getReasoningValue('summaryEnabled', false)"
            :placeholder="t('components.channels.openai-responses.thinking.summaryPlaceholder')"
            @update:model-value="(v: string) => updateReasoning('summary', v)"
          />
          <span class="option-hint">
            {{ t('components.channels.openai-responses.thinking.summaryHint') }}
          </span>
        </div>
      </div>
    </div>
    
    <!-- 思考回传配置 -->
    <div v-if="config.authMode !== 'chatgpt'" class="option-section thinking-backfill-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-sync"></i>
          {{ t('components.channels.common.thinkingBackfill.title') }}
        </span>
      </div>
      
      <div class="option-section-content">
        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.replayReasoningContent !== false"
              @change="(e: any) => emit('update:field', 'replayReasoningContent', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.content') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.contentHint') }}</span>
        </div>

        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.sendHistoryThoughtSignatures ?? false"
              @change="onSendThoughtSignaturesChange"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.signatures') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.signaturesHint') }}</span>
        </div>

        <div class="option-item">
          <label>{{ t('components.channels.openai-responses.reasoningSignatureMode.label') }}</label>
          <CustomSelect
            :model-value="config.reasoningSignatureMode ?? 'official'"
            :options="reasoningSignatureModeOptions"
            :disabled="!(config.sendHistoryThoughtSignatures ?? false)"
            :placeholder="t('components.channels.openai-responses.reasoningSignatureMode.placeholder')"
            @update:model-value="onReasoningSignatureModeChange"
          />
          <span class="option-hint">
            {{ t('components.channels.openai-responses.reasoningSignatureMode.hint') }}
          </span>
        </div>
        
        <!-- 历史思考回合数配置 - 条件展开 -->
        <div
          v-if="config.sendHistoryThoughtSignatures ?? false"
          class="option-item history-rounds-config"
        >
          <label>{{ t('components.channels.common.thinkingBackfill.roundsLabel') }}</label>
          <input
            type="number"
            :value="historyThinkingRoundsDraft"
            placeholder="-1"
            min="-1"
            @input="(e: any) => handleHistoryThinkingRoundsInput(e.target.value, v => emit('update:field', 'historyThinkingRounds', v))"
          />
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.roundsHint') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.openai-responses-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-item label {
  font-size: 11px;
  font-weight: 500;
  color: var(--gc-text-primary);
  opacity: 0.9;
}

.option-item input[type="number"] {
  padding: 5px 8px;
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-xs);
  font-size: 12px;
  appearance: textfield;
  -moz-appearance: textfield;
}

.option-item input[type="number"]::-webkit-outer-spin-button,
.option-item input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.option-item input[type="number"]:focus {
  outline: none;
  border-color: var(--gc-focus-border);
}

.option-item input.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.option-hint {
  font-size: 10px;
  color: var(--gc-text-muted);
  opacity: 0.8;
}

.option-item.checkbox-option {
  flex-direction: row;
  align-items: center;
}

.option-item.checkbox-option .custom-checkbox {
  padding-left: 22px;
}

.option-item.checkbox-option .checkmark {
  width: 14px;
  height: 14px;
}

.option-item.checkbox-option .checkbox-text {
  font-size: 11px;
}

/* 选项分组 */
.option-section {
  margin-top: 8px;
  padding: 12px;
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
}

.option-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--gc-border-subtle);
}

.option-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--gc-text-primary);
}

.option-section-title .codicon {
  font-size: 14px;
  color: var(--gc-chart-blue);
}

.option-section-title .codicon-lightbulb {
  color: var(--gc-chart-yellow);
}

.thinking-backfill-section {
  margin-top: 12px;
}

.backfill-group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--gc-text-muted);
  letter-spacing: 0.4px;
}

.backfill-group-label:not(:first-child) {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--gc-border-subtle);
}

.option-section-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-section-content.disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* 带开关的配置项 */
.option-item.option-with-toggle {
  position: relative;
}

.option-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.option-header label:first-child {
  font-size: 11px;
  font-weight: 500;
  color: var(--gc-text-primary);
  opacity: 0.9;
}

/* 自定义勾选框 */
.custom-checkbox {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  font-weight: normal;
  position: relative;
  padding-left: 26px;
  user-select: none;
}

.custom-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.custom-checkbox .checkmark {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 16px;
  width: 16px;
  background: var(--gc-surface-input);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-xs);
  transition: all 0.15s;
}

.custom-checkbox:hover .checkmark {
  border-color: var(--gc-focus-border);
}

.custom-checkbox input:checked ~ .checkmark {
  background: var(--gc-button-primary);
  border-color: var(--gc-button-primary);
}

.custom-checkbox .checkmark::after {
  content: '';
  position: absolute;
  display: none;
  border: solid var(--gc-text-on-primary);
  border-width: 0 2px 2px 0;
}

.custom-checkbox input:checked ~ .checkmark::after {
  display: block;
}

.checkbox-text {
  margin-left: 4px;
}
</style>
