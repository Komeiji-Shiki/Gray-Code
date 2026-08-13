<script setup lang="ts">
/**
 * ChannelTokenCountMethod - 渠道 Token 计数方式折叠面板
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：展开状态 / 计数方式与 API 配置由父组件注入，自身不持有业务状态。
 */
import { TokenCountMethodSettings } from '../channels'
import { t } from '@/i18n'
import type { ChannelType, TokenCountApiConfig, TokenCountMethod } from '@/types'

defineProps<{
  show: boolean
  tokenCountMethod: TokenCountMethod
  tokenCountApiConfig: TokenCountApiConfig
  channelType: ChannelType
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:token-count-method', value: TokenCountMethod): void
  (e: 'update:token-count-api-config', value: TokenCountApiConfig): void
}>()
</script>

<template>
  <div class="form-group" data-search-anchor="token-count-method">
    <button class="advanced-toggle" @click="emit('update:show', !show)">
      <i :class="['codicon', show ? 'codicon-chevron-down' : 'codicon-chevron-right']"></i>
      <span>{{ t('components.channels.tokenCountMethod.title') }}</span>
    </button>

    <div v-if="show" class="custom-panel-wrapper">
      <TokenCountMethodSettings
        :token-count-method="tokenCountMethod"
        :token-count-api-config="tokenCountApiConfig"
        :channel-type="channelType"
        @update:token-count-method="(v: TokenCountMethod) => emit('update:token-count-method', v)"
        @update:token-count-api-config="(v: TokenCountApiConfig) => emit('update:token-count-api-config', v)"
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

.custom-panel-wrapper {
  margin-top: 12px;
  padding: 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 2px;
}
</style>
