<script setup lang="ts">
import { computed } from 'vue';
import CustomSelect from '../common/CustomSelect.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ modelValue: string; levels: string[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { t } = useI18n();
const labels: Record<string, string> = { none: 'effortNone', minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', xhigh: 'effortXHigh', max: 'effortMax', ultra: 'effortUltra' };
const options = computed(() => [
  { value: '', label: '跟随渠道设置', description: '使用渠道原有配置，新对话默认使用此项。' },
  ...props.levels.map(value => ({ value, label: labels[value] ? t(`components.channels.openai.thinking.${labels[value]}`) : value, description: value })),
]);
</script>

<template>
  <div class="reasoning-selector" title="思考强度仅用于当前对话，不修改渠道设置">
    <span class="reasoning-caption">思考</span>
    <CustomSelect :model-value="modelValue" :options="options" aria-label="当前对话思考强度" :placeholder="modelValue ? `${modelValue}（当前模型不可用）` : undefined" :disabled="disabled" drop-up compact dropdown-fit-content
      @update:model-value="emit('update:modelValue', $event)" />
  </div>
</template>

<style scoped>
.reasoning-selector{display:flex;align-items:center;gap:5px;min-width:0;flex:0 0 auto}.reasoning-caption{color:var(--gc-text-muted);font-size:11px;white-space:nowrap}
.reasoning-selector :deep(.select-trigger){height:var(--gc-control-height-md);padding:0 var(--gc-space-2);background:var(--gc-surface-base);border:1px solid var(--gc-border-subtle);border-radius:0}
.reasoning-selector :deep(.custom-select){width:auto;min-width:105px;max-width:155px}.reasoning-selector :deep(.selected-label){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
