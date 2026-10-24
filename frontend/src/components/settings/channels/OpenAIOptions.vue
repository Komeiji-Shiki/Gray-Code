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
  { value: 'none', label: t('components.channels.openai.thinking.effortNone'), description: '' },
  { value: 'minimal', label: t('components.channels.openai.thinking.effortMinimal'), description: '' },
  { value: 'low', label: t('components.channels.openai.thinking.effortLow'), description: '' },
  { value: 'medium', label: t('components.channels.openai.thinking.effortMedium'), description: '' },
  { value: 'high', label: t('components.channels.openai.thinking.effortHigh'), description: '' },
  { value: 'xhigh', label: t('components.channels.openai.thinking.effortXHigh'), description: '' },
  { value: 'max', label: t('components.channels.openai.thinking.effortMax'), description: '' },
  { value: 'ultra', label: t('components.channels.openai.thinking.effortUltra'), description: '' },
  { value: 'custom', label: t('components.channels.openai.thinking.effortCustom'), description: '' }
])

// 默认配置值
const DEFAULT_VALUES: Record<string, any> = {
  temperature: 1.0,
  max_tokens: 8192,
  top_p: 1.0,
  frequency_penalty: 0,
  presence_penalty: 0,
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

// OAI 的 reasoning_content 不应因 assistant 消息从当前轮次转为历史轮次而改变。
// 界面使用单一开关，同时写回两个旧字段，兼顾现有配置格式和跨渠道切换。
function onSendThoughtsChange(e: any) {
  const value = e.target.checked
  emit('update:field', 'sendHistoryThoughts', value)
  emit('update:field', 'sendCurrentThoughts', value)
}
</script>

<template>
  <div class="openai-options">
    <!-- DeepSeek 三卡片紧凑组（组内卡片之间不留间距） -->
    <div class="deepseek-toggles-group">
    <!-- DeepSeek user_id -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-key"></i>
          {{ t('components.channels.openai.deepSeekUserId.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.deepSeekUserIdEnabled ?? false"
          :title="t('components.channels.openai.deepSeekUserId.toggleHint')"
          :aria-label="t('components.channels.openai.deepSeekUserId.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'deepSeekUserIdEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai.deepSeekUserId.hint') }}</span>
      </div>
    </div>

    <!-- DeepSeek Vision 图片/PDF 预处理 -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-eye"></i>
          {{ t('components.channels.openai.deepSeekVision.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.deepSeekVisionEnabled ?? false"
          :title="t('components.channels.openai.deepSeekVision.toggleHint')"
          :aria-label="t('components.channels.openai.deepSeekVision.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'deepSeekVisionEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai.deepSeekVision.hint') }}</span>
      </div>
    </div>

    <!-- PDF 附件发送（file 内容块） -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-file-pdf"></i>
          {{ t('components.channels.openai.pdfAttachment.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.pdfAttachmentEnabled ?? false"
          :title="t('components.channels.openai.pdfAttachment.toggleHint')"
          :aria-label="t('components.channels.openai.pdfAttachment.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'pdfAttachmentEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai.pdfAttachment.hint') }}</span>
      </div>
    </div>

    <!-- 工具附件改用 user 消息（严格兼容端点） -->
    <div class="option-section">
      <div class="option-section-header">
        <span class="option-section-title">
          <i class="codicon codicon-file-media"></i>
          {{ t('components.channels.openai.toolMediaUserMessage.title') }}
        </span>
        <CustomSwitch
          compact
          :model-value="config.toolMediaUserMessageEnabled ?? false"
          :title="t('components.channels.openai.toolMediaUserMessage.toggleHint')"
          :aria-label="t('components.channels.openai.toolMediaUserMessage.toggleHint')"
          @update:model-value="(value: boolean) => emit('update:field', 'toolMediaUserMessageEnabled', value)"
        />
      </div>
      <div class="option-section-content">
        <span class="option-hint">{{ t('components.channels.openai.toolMediaUserMessage.hint') }}</span>
      </div>
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
        <label>{{ t('components.channels.common.maxTokens.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('max_tokens')"
          :title="t('components.channels.common.maxTokens.toggleHint')"
          :aria-label="t('components.channels.common.maxTokens.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('max_tokens', value)"
        />
      </div>
      <input
        type="number"
        :value="config.options?.max_tokens"
        :placeholder="t('components.channels.common.maxTokens.placeholder')"
        :disabled="!isOptionEnabled('max_tokens')"
        :class="{ disabled: !isOptionEnabled('max_tokens') }"
        @input="(e: any) => handleNumberChange('max_tokens', e)"
      />
    </div>
    
    <!-- Top-P -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.common.topP.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('top_p')"
          :title="t('components.channels.common.topP.toggleHint')"
          :aria-label="t('components.channels.common.topP.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('top_p', value)"
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="0"
        max="1"
        :value="config.options?.top_p"
        placeholder="1.0"
        :disabled="!isOptionEnabled('top_p')"
        :class="{ disabled: !isOptionEnabled('top_p') }"
        @input="(e: any) => handleNumberChange('top_p', e)"
      />
      <span class="option-hint">{{ t('components.channels.common.topP.hint') }}</span>
    </div>
    
    <!-- 频率惩罚 -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.openai.frequencyPenalty.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('frequency_penalty')"
          :title="t('components.channels.openai.frequencyPenalty.toggleHint')"
          :aria-label="t('components.channels.openai.frequencyPenalty.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('frequency_penalty', value)"
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="-2"
        max="2"
        :value="config.options?.frequency_penalty"
        placeholder="0"
        :disabled="!isOptionEnabled('frequency_penalty')"
        :class="{ disabled: !isOptionEnabled('frequency_penalty') }"
        @input="(e: any) => handleNumberChange('frequency_penalty', e)"
      />
      <span class="option-hint">{{ t('components.channels.openai.frequencyPenalty.hint') }}</span>
    </div>
    
    <!-- 存在惩罚 -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.openai.presencePenalty.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('presence_penalty')"
          :title="t('components.channels.openai.presencePenalty.toggleHint')"
          :aria-label="t('components.channels.openai.presencePenalty.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('presence_penalty', value)"
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="-2"
        max="2"
        :value="config.options?.presence_penalty"
        placeholder="0"
        :disabled="!isOptionEnabled('presence_penalty')"
        :class="{ disabled: !isOptionEnabled('presence_penalty') }"
        @input="(e: any) => handleNumberChange('presence_penalty', e)"
      />
      <span class="option-hint">{{ t('components.channels.openai.presencePenalty.hint') }}</span>
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
          <label>{{ t('components.channels.openai.thinking.effortLabel') }}</label>
          <CustomSelect
            :model-value="getReasoningValue('effort', 'high')"
            :options="effortOptions"
            :disabled="!isOptionEnabled('reasoning')"
            :placeholder="t('components.channels.openai.thinking.effortPlaceholder')"
            @update:model-value="(v: string) => updateReasoning('effort', v)"
          />
          <input
            v-if="getReasoningValue('effort') === 'custom'"
            type="text"
            :value="getReasoningValue('effortCustom', '')"
            :placeholder="t('components.channels.openai.thinking.effortCustomPlaceholder')"
            :disabled="!isOptionEnabled('reasoning')"
            :class="{ disabled: !isOptionEnabled('reasoning') }"
            @input="(e: any) => updateReasoning('effortCustom', e.target.value)"
          />
          <span class="option-hint">
            {{ t('components.channels.openai.thinking.effortHint') }}
          </span>
        </div>
        

      </div>
    </div>
    
    <!-- 思考回传配置 -->
    <div class="option-section thinking-backfill-section">
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
              :checked="config.sendHistoryThoughts ?? false"
              @change="onSendThoughtsChange"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.content') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.openai.thinkingBackfill.sendContentHint') }}</span>
        </div>

        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.sendHistoryThoughtSignatures ?? false"
              @change="(e: any) => emit('update:field', 'sendHistoryThoughtSignatures', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.historySignatures') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.openai.thinkingBackfill.sendSignaturesHint') }}</span>
        </div>
        
        <!-- 历史思考回合数配置 - 条件展开 -->
        <div
          v-if="(config.sendHistoryThoughtSignatures ?? false) || (config.sendHistoryThoughts ?? false)"
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
.openai-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* DeepSeek 三卡片紧凑组：组内卡片紧贴，整组与上下内容仍保持原间距 */
.deepseek-toggles-group {
  display: flex;
  flex-direction: column;
}

.deepseek-toggles-group .option-section {
  margin-top: 0;
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
