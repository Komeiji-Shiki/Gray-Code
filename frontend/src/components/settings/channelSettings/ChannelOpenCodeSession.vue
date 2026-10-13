<script setup lang="ts">
/**
 * OpenCode Go 会话标头兼容开关。
 *
 * 该选项属于渠道级传输行为，不依赖某一种请求格式；由后端在统一推理出口处理。
 */
import { t } from '@/i18n'
import { CustomSwitch } from '../../common'

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
      <CustomSwitch
        compact
        :model-value="enabled"
        :title="t('components.settings.channelSettings.form.openCodeSession.enableTitle')"
        :aria-label="t('components.settings.channelSettings.form.openCodeSession.enableTitle')"
        @update:model-value="(value: boolean) => emit('update:enabled', value)"
      />
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
  background: var(--gc-quote-bg);
  border-radius: var(--gc-radius-xs);
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
  color: var(--gc-chart-blue);
}

.session-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--gc-text-primary);
}

.session-hint {
  font-size: 10px;
  line-height: 1.45;
  color: var(--gc-text-muted);
}

</style>
