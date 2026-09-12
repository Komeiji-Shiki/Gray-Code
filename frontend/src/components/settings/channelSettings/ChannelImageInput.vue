<script setup lang="ts">
import type { ChannelConfig } from '@/types'
import { t } from '@/i18n'
import { inputImageLimit } from '@shared/inputImages'
import { useDeferredNumberInput } from '@/composables/useDeferredNumberInput'

const props = defineProps<{ config: ChannelConfig }>()
const emit = defineEmits<{ 'update:limit': [value: number] }>()
const { draft, handleInput } = useDeferredNumberInput(() => inputImageLimit(props.config) ?? 0,
  value => Number.isSafeInteger(value) && value >= 0)
</script>

<template>
  <div class="input-image-limit" data-search-anchor="input-image-limit">
    <div><label :for="`input-images-${config.id}`">{{ t('components.channels.imageInput.label') }}</label>
      <p>{{ t('components.channels.imageInput.hint') }}</p></div>
    <input :id="`input-images-${config.id}`" type="number" min="0" step="1" :value="draft"
      :aria-label="t('components.channels.imageInput.label')" :placeholder="t('components.channels.imageInput.placeholder')"
      @input="event => handleInput((event.target as HTMLInputElement).value, value => emit('update:limit', value))" />
  </div>
</template>

<style scoped>
.input-image-limit { display: grid; grid-template-columns: minmax(0, 1fr) 140px; gap: 16px; align-items: start; padding: 16px 0; border-block: 1px solid var(--vscode-panel-border); }
label { font-size: 13px; color: var(--vscode-foreground); } p { margin: 7px 0 0; font-size: 12px; line-height: 1.6; color: var(--vscode-descriptionForeground); }
input { min-width: 0; width: 100%; height: 34px; padding: 6px 10px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 0; }
input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
@media (max-width: 600px) { .input-image-limit { grid-template-columns: 1fr; gap: 10px; } input { max-width: 180px; } }
</style>
