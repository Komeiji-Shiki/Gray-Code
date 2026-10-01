<script setup lang="ts">
import ChannelSelector from './ChannelSelector.vue'
import ModelSelector from './ModelSelector.vue'
import ReasoningSelector from './ReasoningSelector.vue'
import ModeSelector from './ModeSelector.vue'
import type { ChannelOption, PromptMode, ModelInfo } from './types'

import { useI18n } from '../../i18n'

const { t } = useI18n()

const props = defineProps<{
  currentModeId: string
  modeOptions: PromptMode[]
  isLoadingConfigs: boolean

  configId: string
  channelOptions: ChannelOption[]

  currentModelId: string
  modelOptions: ModelInfo[]
  modelDisabled: boolean
  reasoningEffort?: string
  reasoningLevels?: string[]
}>()

const emit = defineEmits<{
  (e: 'mode-change', modeId: string): void
  (e: 'open-mode-settings'): void
  (e: 'channel-change', channelId: string): void
  (e: 'model-change', modelId: string): void
  (e: 'reasoning-change', effort: string): void
}>()
</script>

<template>
  <div class="selector-bar">
    <div v-if="props.channelOptions.find(option => option.id === props.configId)?.authMode === 'chatgpt'" class="chatgpt-plan-status">
      <span>{{ t('desktop.chatgpt.usingPlan') }}</span>
      <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener noreferrer">{{ t('desktop.chatgpt.usage') }}</a>
    </div>
    <div class="mode-selector-wrapper">
      <ModeSelector
        :model-value="props.currentModeId"
        :options="props.modeOptions"
        :disabled="props.isLoadingConfigs"
        :drop-up="true"
        @update:model-value="emit('mode-change', $event)"
        @open-settings="emit('open-mode-settings')"
      />
    </div>

    <div class="channel-selector-wrapper">
      <ChannelSelector
        :model-value="props.configId"
        :options="props.channelOptions"
        :placeholder="t('components.input.selectChannel')"
        :disabled="props.isLoadingConfigs"
        :drop-up="true"
        @update:model-value="emit('channel-change', $event)"
      />
    </div>

    <div class="model-selector-wrapper">
      <ModelSelector
        :models="props.modelOptions"
        :model-value="props.currentModelId"
        :disabled="props.modelDisabled"
        @update:model-value="emit('model-change', $event)"
      />
      <ReasoningSelector v-if="props.reasoningLevels?.length || props.reasoningEffort" :model-value="props.reasoningEffort ?? ''"
        :levels="props.reasoningLevels ?? []" :disabled="props.modelDisabled" @update:model-value="emit('reasoning-change', $event)" />
    </div>
  </div>
</template>

<style scoped>
.chatgpt-plan-status { flex-basis: 100%; display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--gc-text-muted); }
.chatgpt-plan-status a { color: var(--gc-link); }
.selector-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gc-space-1);
  min-width: 0;
}

.mode-selector-wrapper,
.channel-selector-wrapper,
.model-selector-wrapper {
  min-width: 0;
  max-width: 100%;
}
.model-selector-wrapper { display: flex; align-items: center; gap: var(--gc-space-1); }

/* 胶囊：宽度随内容，过长时截断；下拉面板位置沿用组件自身逻辑。 */
.selector-bar :deep(.mode-trigger),
.selector-bar :deep(.selector-trigger),
.selector-bar :deep(.model-trigger),
.selector-bar :deep(.select-trigger) {
  width: auto;
  min-width: 0;
  max-width: 220px;
  height: 24px;
  min-height: 0;
  padding: 0 var(--gc-space-2);
  border: 0;
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-hover);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
}

.selector-bar :deep(.mode-trigger:hover),
.selector-bar :deep(.selector-trigger:hover),
.selector-bar :deep(.model-trigger:hover),
.selector-bar :deep(.select-trigger:hover) {
  color: var(--gc-text-primary);
  background: var(--gc-surface-active);
}

.selector-bar :deep(.mode-name),
.selector-bar :deep(.placeholder),
.selector-bar :deep(.selected-label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selector-bar :deep(.select-arrow),
.selector-bar :deep(.arrow-icon) {
  font-size: 12px;
  margin-left: var(--gc-space-1);
}

.channel-selector-wrapper :deep(.selector-dropdown) { min-width: 180px; max-width: calc(100vw - var(--gc-space-8)); }
.model-selector-wrapper :deep(.model-dropdown) { min-width: 240px; max-width: calc(100vw - var(--gc-space-8)); }
</style>