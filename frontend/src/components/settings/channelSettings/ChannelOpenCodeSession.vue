<script setup lang="ts">
/**
 * OpenCode Go 会话标头兼容开关。
 *
 * 该选项属于渠道级传输行为，不依赖某一种请求格式；由后端在统一推理出口处理。
 */
import { t } from '@/i18n'

defineProps<{
  enabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:enabled', value: boolean): void
}>()
</script>

<template>
  <div class="form-group" data-search-anchor="opencode-session">
    <div class="opencode-session-card">
      <div class="session-copy">
        <div class="session-title-row">
          <i class="codicon codicon-history"></i>
          <span class="session-title">{{ t('components.settings.channelSettings.form.openCodeSession.title') }}</span>
        </div>
        <span class="session-hint">{{ t('components.settings.channelSettings.form.openCodeSession.hint') }}</span>
      </div>
      <label class="toggle-switch" :title="t('components.settings.channelSettings.form.openCodeSession.enableTitle')">
        <input
          type="checkbox"
          :checked="enabled"
          @change="(e: any) => emit('update:enabled', e.target.checked)"
        />
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.form-group {
  margin-bottom: 12px;
}

.opencode-session-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 2px;
}

.session-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.session-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.session-title-row .codicon {
  font-size: 14px;
  color: var(--vscode-charts-blue, #3794ff);
}

.session-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.session-hint {
  font-size: 10px;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground);
}

.toggle-switch {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 32px;
  height: 16px;
  margin-top: 2px;
  cursor: pointer;
}

.toggle-switch input {
  width: 0;
  height: 0;
  opacity: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background-color: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 8px;
  transition: all 0.2s;
}

.toggle-slider::before {
  position: absolute;
  bottom: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  content: '';
  background-color: var(--vscode-foreground);
  border-radius: 50%;
  opacity: 0.6;
  transition: all 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.toggle-switch input:checked + .toggle-slider::before {
  background-color: var(--vscode-button-foreground);
  transform: translateX(16px);
  opacity: 1;
}

.toggle-switch:hover .toggle-slider {
  border-color: var(--vscode-focusBorder);
}
</style>
