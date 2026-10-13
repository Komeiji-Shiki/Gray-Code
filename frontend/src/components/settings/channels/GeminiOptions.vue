<script setup lang="ts">
import { computed, watch } from 'vue'
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

// 思考等级选项
const thinkingLevelOptions = computed<SelectOption[]>(() => [
  { value: 'minimal', label: t('components.channels.gemini.thinking.levelMinimal'), description: '' },
  { value: 'low', label: t('components.channels.gemini.thinking.levelLow'), description: '' },
  { value: 'medium', label: t('components.channels.gemini.thinking.levelMedium'), description: '' },
  { value: 'high', label: t('components.channels.gemini.thinking.levelHigh'), description: '' }
])

// 默认配置值
const DEFAULT_VALUES: Record<string, any> = {
  temperature: 1.0,
  maxOutputTokens: 65535,
  thinkingConfig: {
    includeThoughts: true,
    mode: 'default',
    thinkingLevel: 'low',
    thinkingBudget: 1024
  }
}

const {
  isOptionEnabled, handleOptionEnabledChange, getNestedOptionValue, updateNestedOption
} = useChannelOptions(() => props.config, DEFAULT_VALUES, {
  option: (key, value) => emit('update:option', key, value),
  enabled: (key, enabled, ...values) => emit('update:optionEnabled', key, enabled, ...values)
})

// 获取思考配置字段值
function getThinkingConfigValue(field: string, defaultValue: any = undefined): any {
  return getNestedOptionValue('thinkingConfig', field, defaultValue)
}

// 更新思考配置字段
function updateThinkingConfig(field: string, value: any) {
  updateNestedOption('thinkingConfig', field, value)
}

// ============ 草稿模式数字输入 ============
// 清空后不立即回填默认值（编辑期间保持为空）；离开设置页时自动回填已保存值。
const {
  draft: temperatureDraft,
  handleInput: handleTemperatureInput,
  syncFromStored: syncTemperatureFromStored,
  touched: temperatureTouched
} = useDeferredNumberInput(() => props.config?.options?.temperature ?? 1.0)
const {
  draft: maxOutputTokensDraft,
  handleInput: handleMaxOutputTokensInput,
  syncFromStored: syncMaxOutputTokensFromStored,
  touched: maxOutputTokensTouched
} = useDeferredNumberInput(() => props.config?.options?.maxOutputTokens ?? 65535)
const {
  draft: thinkingBudgetDraft,
  handleInput: handleThinkingBudgetInput,
  syncFromStored: syncThinkingBudgetFromStored,
  touched: thinkingBudgetTouched
} = useDeferredNumberInput(() => props.config?.options?.thinkingConfig?.thinkingBudget ?? 1024)
const {
  draft: historyThinkingRoundsDraft,
  handleInput: handleHistoryThinkingRoundsInput,
  syncFromStored: syncHistoryThinkingRoundsFromStored,
  touched: historyThinkingRoundsTouched
} = useDeferredNumberInput(() => props.config?.historyThinkingRounds ?? -1)

// 外部配置更新时同步草稿（用户已手动输入过的字段不被覆盖，
// 避免快速连打时响应竞态把未提交的草稿回退）。
// 引用级 watch 即可：ChannelSettings 重载配置时整体替换 config 引用，
// deep watch 会对整个嵌套配置树（含 models 数组、options）逐属性遍历，纯属浪费。
watch(
  () => props.config,
  () => {
    if (!temperatureTouched.value) syncTemperatureFromStored()
    if (!maxOutputTokensTouched.value) syncMaxOutputTokensFromStored()
    if (!thinkingBudgetTouched.value) syncThinkingBudgetFromStored()
    if (!historyThinkingRoundsTouched.value) syncHistoryThinkingRoundsFromStored()
  }
)
</script>

<template>
  <div class="gemini-options">
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
        :value="temperatureDraft"
        placeholder="1.0"
        :disabled="!isOptionEnabled('temperature')"
        :class="{ disabled: !isOptionEnabled('temperature') }"
        @input="(e: any) => handleTemperatureInput(e.target.value, v => emit('update:option', 'temperature', v))"
      />
      <span class="option-hint">{{ t('components.channels.common.temperature.hint') }}</span>
    </div>
    
    <!-- 最大输出 Tokens -->
    <div class="option-item option-with-toggle">
      <div class="option-header">
        <label>{{ t('components.channels.common.maxTokens.label') }}</label>
        <CustomSwitch
          compact
          :model-value="isOptionEnabled('maxOutputTokens')"
          :title="t('components.channels.common.maxTokens.toggleHint')"
          :aria-label="t('components.channels.common.maxTokens.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('maxOutputTokens', value)"
        />
      </div>
      <input
        type="number"
        :value="maxOutputTokensDraft"
        placeholder="65535"
        :disabled="!isOptionEnabled('maxOutputTokens')"
        :class="{ disabled: !isOptionEnabled('maxOutputTokens') }"
        @input="(e: any) => handleMaxOutputTokensInput(e.target.value, v => emit('update:option', 'maxOutputTokens', v))"
      />
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
          :model-value="isOptionEnabled('thinkingConfig')"
          :title="t('components.channels.common.thinking.toggleHint')"
          :aria-label="t('components.channels.common.thinking.toggleHint')"
          @update:model-value="(value: boolean) => handleOptionEnabledChange('thinkingConfig', value)"
        />
      </div>
      
      <div class="option-section-content" :class="{ disabled: !isOptionEnabled('thinkingConfig') }">
        <!-- 包含思考内容 -->
        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="getThinkingConfigValue('includeThoughts', false)"
              :disabled="!isOptionEnabled('thinkingConfig')"
              @change="(e: any) => updateThinkingConfig('includeThoughts', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.gemini.thinking.includeThoughts') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.gemini.thinking.includeThoughtsHint') }}</span>
        </div>
        
        <!-- 思考模式 -->
        <div class="option-item">
          <label>{{ t('components.channels.gemini.thinking.mode') }}</label>
          <div class="radio-group">
            <label class="radio-option" :class="{ disabled: !isOptionEnabled('thinkingConfig') }">
              <input
                type="radio"
                name="thinkingMode"
                value="default"
                :checked="getThinkingConfigValue('mode', 'default') === 'default'"
                :disabled="!isOptionEnabled('thinkingConfig')"
                @change="updateThinkingConfig('mode', 'default')"
              />
              <span class="radio-mark"></span>
              <span class="radio-text">{{ t('components.channels.gemini.thinking.modeDefault') }}</span>
            </label>
            <label class="radio-option" :class="{ disabled: !isOptionEnabled('thinkingConfig') }">
              <input
                type="radio"
                name="thinkingMode"
                value="level"
                :checked="getThinkingConfigValue('mode', 'default') === 'level'"
                :disabled="!isOptionEnabled('thinkingConfig')"
                @change="updateThinkingConfig('mode', 'level')"
              />
              <span class="radio-mark"></span>
              <span class="radio-text">{{ t('components.channels.gemini.thinking.modeLevel') }}</span>
            </label>
            <label class="radio-option" :class="{ disabled: !isOptionEnabled('thinkingConfig') }">
              <input
                type="radio"
                name="thinkingMode"
                value="budget"
                :checked="getThinkingConfigValue('mode', 'default') === 'budget'"
                :disabled="!isOptionEnabled('thinkingConfig')"
                @change="updateThinkingConfig('mode', 'budget')"
              />
              <span class="radio-mark"></span>
              <span class="radio-text">{{ t('components.channels.gemini.thinking.modeBudget') }}</span>
            </label>
          </div>
          <span class="option-hint">{{ t('components.channels.gemini.thinking.modeHint') }}</span>
        </div>
        
        <!-- 思考等级（等级模式下显示） -->
        <div v-if="getThinkingConfigValue('mode', 'default') === 'level'" class="option-item">
          <label>{{ t('components.channels.gemini.thinking.levelLabel') }}</label>
          <CustomSelect
            :model-value="getThinkingConfigValue('thinkingLevel', 'low')"
            :options="thinkingLevelOptions"
            :disabled="!isOptionEnabled('thinkingConfig')"
            :placeholder="t('components.channels.gemini.thinking.levelPlaceholder')"
            @update:model-value="(v: string) => updateThinkingConfig('thinkingLevel', v)"
          />
          <span class="option-hint">{{ t('components.channels.gemini.thinking.levelHint') }}</span>
        </div>
        
        <!-- 思考预算（预算模式下显示） -->
        <div v-if="getThinkingConfigValue('mode', 'default') === 'budget'" class="option-item">
          <label>{{ t('components.channels.gemini.thinking.budgetLabel') }}</label>
          <input
            type="number"
            :value="thinkingBudgetDraft"
            :placeholder="t('components.channels.gemini.thinking.budgetPlaceholder')"
            :disabled="!isOptionEnabled('thinkingConfig')"
            :class="{ disabled: !isOptionEnabled('thinkingConfig') }"
            @input="(e: any) => handleThinkingBudgetInput(e.target.value, v => updateThinkingConfig('thinkingBudget', v))"
          />
          <span class="option-hint">{{ t('components.channels.gemini.thinking.budgetHint') }}</span>
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
        <div class="backfill-group-label">{{ t('components.channels.common.thinkingBackfill.currentGroup') }}</div>

        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.sendCurrentThoughtSignatures ?? true"
              @change="(e: any) => emit('update:field', 'sendCurrentThoughtSignatures', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.currentSignatures') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.currentSignaturesHint') }}</span>
        </div>
        
        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.sendCurrentThoughts ?? true"
              @change="(e: any) => emit('update:field', 'sendCurrentThoughts', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.currentContent') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.currentContentHint') }}</span>
        </div>

        <div class="backfill-group-label">{{ t('components.channels.common.thinkingBackfill.historyGroup') }}</div>

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
          <span class="option-hint">{{ t('components.channels.common.thinkingBackfill.historySignaturesHint') }}</span>
        </div>
        
        <div class="option-item checkbox-option">
          <label class="custom-checkbox">
            <input
              type="checkbox"
              :checked="config.sendHistoryThoughts ?? false"
              @change="(e: any) => emit('update:field', 'sendHistoryThoughts', e.target.checked)"
            />
            <span class="checkmark"></span>
            <span class="checkbox-text">{{ t('components.channels.common.thinkingBackfill.historyContent') }}</span>
          </label>
          <span class="option-hint">{{ t('components.channels.gemini.thinkingBackfill.sendContentHint') }}</span>
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
.gemini-options {
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
  color: var(--gc-chart-yellow);
}

.option-section-title .codicon-history {
  color: var(--gc-chart-blue);
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

/* 单选按钮组 */
.radio-group {
  display: flex;
  gap: 16px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
}

.radio-option.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.radio-option input {
  display: none;
}

.radio-mark {
  width: 14px;
  height: 14px;
  border: 1px solid var(--gc-border-control);
  border-radius: 50%;
  background: var(--gc-surface-input);
  position: relative;
  transition: all 0.15s;
}

.radio-option:hover:not(.disabled) .radio-mark {
  border-color: var(--gc-focus-border);
}

.radio-option input:checked + .radio-mark {
  border-color: var(--gc-button-primary);
}

.radio-option input:checked + .radio-mark::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gc-button-primary);
}

.radio-text {
  color: var(--gc-text-primary);
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
