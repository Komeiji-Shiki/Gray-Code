<script setup lang="ts">
/**
 * ChannelContextManagement - 渠道上下文管理（总结阈值）
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：展开状态 / 开关 / 阈值 / 模式均由父组件注入，自身不持有业务状态。
 */
import { CustomSelect, Tooltip, type SelectOption } from '../../common'
import { computed } from 'vue'
import { t } from '@/i18n'

interface ContextBudgetInfo {
  declaredContextTokens: number
  effectiveInputTokens: number
  maxOutputTokens?: number
  contextWindowIncludesOutput: boolean
  source: 'channel' | 'model' | 'default'
}

const props = defineProps<{
  show: boolean
  contextManagementEnabled: boolean
  contextThreshold: string | number
  contextManagementMode: string
  contextManagementModeOptions: SelectOption[]
  contextThresholdError: boolean
  contextBudget: ContextBudgetInfo
  summaryKeepRecentTokens: string | number | undefined
  summaryKeepRecentRounds: number
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:enabled', value: boolean): void
  (e: 'update:threshold', value: string): void
  (e: 'update:mode', value: string): void
}>()

function formatTokens(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString()
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

const thresholdHelp = computed(() => {
  const raw = String(props.contextThreshold ?? '').trim()
  const percentMatch = raw.match(/^(\d+(?:\.\d+)?)%$/)
  const percentage = percentMatch ? Number(percentMatch[1]) : undefined
  const absolute = percentage === undefined ? parsePositiveNumber(raw) : undefined
  const effectiveInputTokens = props.contextBudget.effectiveInputTokens
  const triggerTokens = percentage === undefined
    ? (absolute ?? Math.floor(effectiveInputTokens * 0.8))
    : Math.floor(effectiveInputTokens * percentage / 100)
  const lines: string[] = []

  if (percentage !== undefined) {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.percentage', {
      percent: percentage,
      budget: formatTokens(effectiveInputTokens),
      trigger: formatTokens(triggerTokens)
    }))
  } else if (absolute !== undefined) {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.absolute', {
      trigger: formatTokens(absolute)
    }))
  } else {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.invalid'))
  }

  if (props.contextBudget.maxOutputTokens !== undefined && props.contextBudget.contextWindowIncludesOutput) {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.outputBudget', {
      declared: formatTokens(props.contextBudget.declaredContextTokens),
      output: formatTokens(props.contextBudget.maxOutputTokens),
      input: formatTokens(effectiveInputTokens)
    }))
  } else {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.inputBudget', {
      input: formatTokens(effectiveInputTokens)
    }))
  }

  const keepRaw = props.summaryKeepRecentTokens ?? '50%'
  const keepText = String(keepRaw).trim()
  const keepPercentMatch = keepText.match(/^(\d+(?:\.\d+)?)%$/)
  if (keepPercentMatch) {
    const keepPercent = Number(keepPercentMatch[1])
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.summaryPercent', {
      keepPercent,
      summarizePercent: Math.max(0, 100 - keepPercent),
      rounds: props.summaryKeepRecentRounds
    }))
  } else if (parsePositiveNumber(keepText) !== undefined) {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.summaryAbsolute', {
      keepTokens: formatTokens(parsePositiveNumber(keepText)!),
      rounds: props.summaryKeepRecentRounds
    }))
  } else {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.summaryDefault', {
      rounds: props.summaryKeepRecentRounds
    }))
  }

  lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.tokenBasis'))
  if (triggerTokens > effectiveInputTokens) {
    lines.push(t('components.settings.channelSettings.form.contextManagement.threshold.tooltip.overBudget'))
  }
  return lines.join('\n')
})
</script>

<template>
  <div class="form-group" data-search-anchor="context-management">
    <button class="advanced-toggle" @click="emit('update:show', !show)">
      <i :class="['codicon', show ? 'codicon-chevron-down' : 'codicon-chevron-right']"></i>
      <span>{{ t('components.settings.channelSettings.form.contextManagement.title') }}</span>
      <label class="toggle-switch header-toggle" :title="t('components.settings.channelSettings.form.contextManagement.enableTitle')" @click.stop>
        <input
          type="checkbox"
          :checked="contextManagementEnabled"
          @change="(e: any) => emit('update:enabled', e.target.checked)"
        />
        <span class="toggle-slider"></span>
      </label>
    </button>

    <div v-if="show" class="custom-panel-wrapper">
      <div class="context-threshold-options">
        <!-- 模式选择 -->
        <div class="option-item option-with-toggle">
          <div class="option-header">
            <label>{{ t('components.settings.channelSettings.form.contextManagement.mode.label') }}</label>
          </div>
          <CustomSelect
            :model-value="contextManagementMode"
            :options="contextManagementModeOptions"
            :disabled="!contextManagementEnabled"
            compact
            @update:model-value="(v: string) => emit('update:mode', v)"
          />
          <span class="option-hint">
            {{ t('components.settings.channelSettings.form.contextManagement.mode.hint') }}
          </span>
        </div>

        <!-- 阈值（两种模式共用） -->
        <div class="option-item option-with-toggle">
          <div class="option-header threshold-option-header">
            <label>{{ t('components.settings.channelSettings.form.contextManagement.threshold.label') }}</label>
            <Tooltip
              :content="thresholdHelp"
              placement="top-right"
              multiline
              max-width="380px"
            >
              <button
                type="button"
                class="threshold-info"
                :aria-label="t('components.settings.channelSettings.form.contextManagement.threshold.infoLabel')"
              >
                <i class="codicon codicon-info"></i>
              </button>
            </Tooltip>
          </div>
          <input
            type="text"
            :value="contextThreshold"
            :placeholder="t('components.settings.channelSettings.form.contextManagement.threshold.placeholder')"
            :disabled="!contextManagementEnabled"
            :class="{ disabled: !contextManagementEnabled, error: contextThresholdError }"
            @input="(e: any) => emit('update:threshold', e.target.value)"
          />
          <span v-if="contextThresholdError" class="option-hint" style="color: var(--vscode-errorForeground)">
            {{ t('components.settings.channelSettings.form.contextManagement.threshold.shortHint') }}（{{ t('components.settings.channelSettings.form.contextManagement.threshold.invalidHint') }}）
          </span>
          <span v-else class="option-hint">
            {{ t('components.settings.channelSettings.form.contextManagement.threshold.shortHint') }}
          </span>
        </div>

        <!-- 旧的整轮额外裁剪设置已停用：总结失败时使用不持久化的工具对安全细粒度裁剪。 -->
      </div>
    </div>
  </div>
</template>

<style scoped>
.threshold-option-header {
  align-items: center;
}

.threshold-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: help;
}

.threshold-info:hover,
.threshold-info:focus-visible {
  color: var(--vscode-textLink-foreground);
  outline: none;
}

.threshold-info .codicon {
  font-size: 14px;
}

.form-group {
  display: flex;

  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.form-group input[type="text"],
.form-group input[type="password"],
.form-group input[type="number"] {
  padding: 6px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 13px;
}

.form-group input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

/* 高级选项 */
.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.advanced-toggle:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.advanced-toggle .codicon {
  font-size: 14px;
}

/* 标头面板的开关放在按钮右侧 */
.advanced-toggle .header-toggle {
  margin-left: auto;
}

/* 通用面板包装器 */
.custom-panel-wrapper {
  margin-top: 12px;
  padding: 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 2px;
}

.option-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-item label {
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-foreground);
  opacity: 0.9;
}

.option-item input[type="number"] {
  padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 12px;
  appearance: textfield;
  -moz-appearance: textfield; /* Firefox */
}

.option-item input[type="number"]:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.option-hint {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
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
  color: var(--vscode-foreground);
  opacity: 0.9;
}

/* 开关样式 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 16px;
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
  background-color: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 8px;
  transition: all 0.2s;
}

.toggle-slider::before {
  position: absolute;
  content: "";
  height: 10px;
  width: 10px;
  left: 2px;
  bottom: 2px;
  background-color: var(--vscode-foreground);
  opacity: 0.6;
  border-radius: 50%;
  transition: all 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background-color: var(--vscode-button-foreground);
  opacity: 1;
}

.toggle-switch:hover .toggle-slider {
  border-color: var(--vscode-focusBorder);
}

/* 禁用状态的输入框 */
.option-item input.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
