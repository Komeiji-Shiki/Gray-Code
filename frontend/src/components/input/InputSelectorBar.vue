<script setup lang="ts">
import ChannelSelector from './ChannelSelector.vue'
import ModelSelector from './ModelSelector.vue'
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
}>()

const emit = defineEmits<{
  (e: 'mode-change', modeId: string): void
  (e: 'open-mode-settings'): void
  (e: 'channel-change', channelId: string): void
  (e: 'model-change', modelId: string): void
}>()
</script>

<template>
  <div class="selector-bar">
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
    </div>
  </div>
</template>

<style scoped>
.selector-bar {
  display: grid;
  grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1fr) minmax(0, 1.4fr);
  align-items: center;
  gap: var(--gc-space-2);
  min-width: 0;
  padding-top: var(--gc-space-2);
  border-top: 1px solid var(--gc-border-subtle);
}

.mode-selector-wrapper,
.channel-selector-wrapper,
.model-selector-wrapper {
  min-width: 0;
}

.mode-selector-wrapper :deep(.mode-selector),
.channel-selector-wrapper :deep(.channel-selector),
.model-selector-wrapper :deep(.model-selector) {
  width: 100%;
  min-width: 0;
}

.selector-bar :deep(.mode-trigger),
.selector-bar :deep(.selector-trigger),
.selector-bar :deep(.model-trigger) {
  width: 100%;
  min-width: 0;
  max-width: none;
  height: var(--gc-control-height-md);
  padding: 0 var(--gc-space-2);
  background: var(--gc-surface-base);
}

.selector-bar :deep(.mode-name),
.selector-bar :deep(.placeholder) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-selector-wrapper :deep(.selector-dropdown) {
  left: auto;
  right: 0;
  width: max(100%, 180px);
  min-width: 0;
  max-width: calc(100vw - var(--gc-space-8));
}

.model-selector-wrapper :deep(.model-dropdown) {
  width: max(100%, 240px);
  min-width: 0;
  max-width: calc(100vw - var(--gc-space-8));
}

@media (max-width: 380px) {
  .selector-bar {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .model-selector-wrapper {
    grid-column: 1 / -1;
  }
}
</style>
