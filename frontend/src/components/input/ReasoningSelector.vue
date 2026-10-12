<script setup lang="ts">
import { computed } from 'vue';
import CustomSelect from '../common/CustomSelect.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ modelValue: string; levels: string[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { t } = useI18n();
const labels: Record<string, string> = { none: 'effortNone', minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', xhigh: 'effortXHigh', max: 'effortMax', ultra: 'effortUltra' };
const options = computed(() => [
  { value: '', label: t('desktop.inputUi.followChannel'), description: t('desktop.inputUi.followChannelDescription') },
  ...props.levels.map(value => ({ value, label: labels[value] ? t(`components.channels.openai.thinking.${labels[value]}`) : value, description: value })),
]);
</script>

<template>
  <div class="reasoning-selector" :title="t('desktop.inputUi.reasoningTitle')">
    <span class="reasoning-caption">{{ t('desktop.inputUi.reasoning') }}</span>
    <CustomSelect
      :model-value="modelValue"
      :options="options"
      :aria-label="t('desktop.inputUi.reasoningLabel')"
      :title="t('desktop.inputUi.reasoningTitle')"
      :placeholder="modelValue ? t('desktop.inputUi.reasoningUnavailable', { value: modelValue }) : undefined"
      :disabled="disabled"
      drop-up
      dropdown-fit-content
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped>
.reasoning-selector {
  display: flex;
  align-items: center;
  gap: var(--gc-space-1);
  margin-left: var(--gc-space-2);
  min-width: 0;
  flex: 0 0 auto;
}

.reasoning-caption {
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  white-space: nowrap;
}

.reasoning-selector :deep(.custom-select) {
  width: auto;
  min-width: 0;
  max-width: 155px;
}
</style>
