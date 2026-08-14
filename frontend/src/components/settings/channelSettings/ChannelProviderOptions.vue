<script setup lang="ts">
/**
 * ChannelProviderOptions - 渠道高级选项折叠面板（Gemini / OpenAI / OpenAI Responses / Anthropic）
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：展开状态 / 当前配置由父组件注入，自身不持有业务状态；
 * - 各渠道子面板的选项变更通过 emits 透传回父组件。
 */
import {
  GeminiOptions,
  OpenAIOptions,
  OpenAIResponsesOptions,
  AnthropicOptions
} from '../channels'
import { t } from '@/i18n'
import type { ChannelConfig } from '@/types'

defineProps<{
  show: boolean
  config: ChannelConfig
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:option', optionKey: string, value: any): void
  (e: 'update:option-enabled', optionKey: string, enabled: boolean, optionValue?: any): void
  (e: 'update:field', field: string, value: any): void
}>()
</script>

<template>
  <div class="form-group" data-search-anchor="advanced-options">
    <button class="advanced-toggle" @click="emit('update:show', !show)">
      <i :class="['codicon', show ? 'codicon-chevron-down' : 'codicon-chevron-right']"></i>
      <span>{{ t('components.settings.channelSettings.form.advancedOptions.title') }}</span>
    </button>

    <div v-if="show" class="advanced-options">
      <!-- Gemini / Gemini Interactions 选项（key=渠道ID：切换配置时重挂载，草稿跟随新配置） -->
      <GeminiOptions
        v-if="config.type === 'gemini' || config.type === 'gemini-interactions'"
        :key="config.id"
        :config="config"
        @update:option="(k: string, v: any) => emit('update:option', k, v)"
        @update:option-enabled="(k: string, enabled: boolean, v?: any) => emit('update:option-enabled', k, enabled, v)"
        @update:field="(f: string, v: any) => emit('update:field', f, v)"
      />

      <!-- OpenAI 选项 -->
      <OpenAIOptions
        v-if="config.type === 'openai'"
        :key="config.id"
        :config="config"
        @update:option="(k: string, v: any) => emit('update:option', k, v)"
        @update:option-enabled="(k: string, enabled: boolean, v?: any) => emit('update:option-enabled', k, enabled, v)"
        @update:field="(f: string, v: any) => emit('update:field', f, v)"
      />

      <!-- OpenAI Responses 选项 -->
      <OpenAIResponsesOptions
        v-if="config.type === 'openai-responses'"
        :key="config.id"
        :config="config"
        @update:option="(k: string, v: any) => emit('update:option', k, v)"
        @update:option-enabled="(k: string, enabled: boolean, v?: any) => emit('update:option-enabled', k, enabled, v)"
        @update:field="(f: string, v: any) => emit('update:field', f, v)"
      />

      <!-- Anthropic 选项 -->
      <AnthropicOptions
        v-if="config.type === 'anthropic'"
        :key="config.id"
        :config="config"
        @update:option="(k: string, v: any) => emit('update:option', k, v)"
        @update:option-enabled="(k: string, enabled: boolean, v?: any) => emit('update:option-enabled', k, enabled, v)"
        @update:field="(f: string, v: any) => emit('update:field', f, v)"
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

.advanced-options {
  margin-top: 12px;
  padding: 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
