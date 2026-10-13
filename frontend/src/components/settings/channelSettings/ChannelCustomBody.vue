<script setup lang="ts">
/**
 * ChannelCustomBody - 渠道自定义 Body 折叠面板
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：展开状态 / 配置 / 启用开关由父组件注入，自身不持有业务状态。
 */
import { CustomBodySettings } from '../channels'
import { t } from '@/i18n'
import { CustomSwitch } from '../../common'
import type { CustomBodyConfig } from '@/types'

defineProps<{
  show: boolean
  customBody: CustomBodyConfig
  enabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:enabled', value: boolean): void
  (e: 'update:config', config: CustomBodyConfig): void
}>()
</script>

<template>
  <div
    class="form-group"
    data-search-anchor="custom-body"
    data-search-reveal
    @settings-search-reveal="emit('update:show', true)"
  >
    <button class="advanced-toggle" @click="emit('update:show', !show)">
      <i :class="['codicon', show ? 'codicon-chevron-down' : 'codicon-chevron-right']"></i>
      <span>{{ t('components.settings.channelSettings.form.customBody.title') }}</span>
      <CustomSwitch
        class="header-toggle"
        compact
        :model-value="enabled"
        :title="t('components.settings.channelSettings.form.customBody.enableTitle')"
        :aria-label="t('components.settings.channelSettings.form.customBody.enableTitle')"
        @click.stop
        @update:model-value="(value: boolean) => emit('update:enabled', value)"
      />
    </button>

    <div v-if="show" class="custom-panel-wrapper">
      <CustomBodySettings
        :custom-body="customBody"
        :enabled="enabled"
        @update:enabled="(v: boolean) => emit('update:enabled', v)"
        @update:config="(c: CustomBodyConfig) => emit('update:config', c)"
      />
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

</style>
