<script setup lang="ts">
/**
 * ChannelAutoRetry - 渠道自动重试折叠面板
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：展开状态 / 启用开关 / 重试草稿值由父组件注入，自身不持有业务状态；
 * - 重试次数/间隔使用草稿输入（useDeferredNumberInput），输入事件回传父组件处理。
 */
import { t } from '@/i18n'
import { CustomSwitch } from '../../common'

defineProps<{
  show: boolean
  retryEnabled: boolean
  retryCountDraft: string
  retryIntervalDraft: string
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:enabled', value: boolean): void
  (e: 'retry-count-input', value: string): void
  (e: 'retry-interval-input', value: string): void
}>()
</script>

<template>
  <div
    class="form-group"
    data-search-anchor="auto-retry"
    data-search-reveal
    @settings-search-reveal="emit('update:show', true)"
  >
    <button class="advanced-toggle" @click="emit('update:show', !show)">
      <i :class="['codicon', show ? 'codicon-chevron-down' : 'codicon-chevron-right']"></i>
      <span>{{ t('components.settings.channelSettings.form.autoRetry.title') }}</span>
      <CustomSwitch
        class="header-toggle"
        compact
        :model-value="retryEnabled"
        :title="t('components.settings.channelSettings.form.autoRetry.enableTitle')"
        :aria-label="t('components.settings.channelSettings.form.autoRetry.enableTitle')"
        @click.stop
        @update:model-value="(value: boolean) => emit('update:enabled', value)"
      />
    </button>

    <div v-if="show" class="custom-panel-wrapper">
      <div class="retry-options">
        <div class="option-item option-with-toggle">
          <div class="option-header">
            <label>{{ t('components.settings.channelSettings.form.autoRetry.retryCount.label') }}</label>
          </div>
          <input
            type="number"
            :value="retryCountDraft"
            min="1"
            max="10"
            :disabled="!retryEnabled"
            :class="{ disabled: !retryEnabled }"
            @input="(e: any) => emit('retry-count-input', e.target.value)"
          />
          <span class="option-hint">{{ t('components.settings.channelSettings.form.autoRetry.retryCount.hint') }}</span>
        </div>

        <div class="option-item option-with-toggle">
          <div class="option-header">
            <label>{{ t('components.settings.channelSettings.form.autoRetry.retryInterval.label') }}</label>
          </div>
          <input
            type="number"
            :value="retryIntervalDraft"
            min="1000"
            max="60000"
            step="1000"
            :disabled="!retryEnabled"
            :class="{ disabled: !retryEnabled }"
            @input="(e: any) => emit('retry-interval-input', e.target.value)"
          />
          <span class="option-hint">{{ t('components.settings.channelSettings.form.autoRetry.retryInterval.hint') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  background: var(--gc-button-secondary);
  color: var(--gc-text-on-secondary);
  border: none;
  border-radius: var(--gc-radius-xs);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.advanced-toggle:hover {
  background: var(--gc-button-secondary-hover);
}

.advanced-toggle .codicon {
  font-size: 14px;
}

.advanced-toggle .header-toggle {
  margin-left: auto;
}

.custom-panel-wrapper {
  margin-top: 12px;
  padding: 12px;
  background: var(--gc-quote-bg);
  border-radius: var(--gc-radius-xs);
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
  -moz-appearance: textfield; /* Firefox */
}

/* 隐藏数字输入框的上下箭头 */
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

.option-hint {
  font-size: 10px;
  color: var(--gc-text-muted);
  opacity: 0.8;
}

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

/* 禁用状态的输入框 */
.option-item input.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
