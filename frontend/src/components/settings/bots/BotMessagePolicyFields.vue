<script setup lang="ts">
import { computed } from 'vue';
import type { BotMessagePolicy } from '../../../../../packages/contracts/src/settings';
import { t } from '../../../i18n';

const props = defineProps<{ modelValue?: Partial<BotMessagePolicy>; inherited?: Partial<BotMessagePolicy>; override?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: BotMessagePolicy | undefined] }>();
const effective = computed(() => ({ mergeWindowMs: 0, cooldownMs: 0, maxPending: 0, ...props.inherited, ...props.modelValue }));
function change(key: keyof BotMessagePolicy, value: string) {
  emit('update:modelValue', { ...effective.value, [key]: Math.round(Number(value) * (key === 'maxPending' ? 1 : 1000)) });
}
</script>
<template>
  <section class="bot-policy">
    <h5>{{ t('desktop.bot.policyTitle') }}</h5>
    <p>{{ t('desktop.bot.policyHint') }}</p>
    <select v-if="override" :value="modelValue ? 'custom' : 'inherit'" :aria-label="t('desktop.bot.policyTitle')"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value === 'inherit' ? undefined : { ...effective })">
      <option value="inherit">{{ t('desktop.bot.inherit') }}</option><option value="custom">{{ t('desktop.bot.custom') }}</option>
    </select>
    <div class="policy-fields">
      <label>{{ t('desktop.bot.mergeWindow') }}<input type="number" min="0" max="10" step="0.1" :disabled="override && !modelValue" :value="effective.mergeWindowMs / 1000" @change="change('mergeWindowMs', ($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('desktop.bot.cooldown') }}<input type="number" min="0" max="3600" step="0.1" :disabled="override && !modelValue" :value="effective.cooldownMs / 1000" @change="change('cooldownMs', ($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('desktop.bot.maxPending') }}<input type="number" min="0" max="1000" step="1" :disabled="override && !modelValue" :value="effective.maxPending" @change="change('maxPending', ($event.target as HTMLInputElement).value)" /></label>
    </div>
  </section>
</template>
<style scoped>
.bot-policy { margin: 20px 0; }
h5 { margin: 0; font-size: 15px; }
p { color: var(--gc-text-muted); line-height: 1.7; }
.policy-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; }
label { display: flex; flex-direction: column; gap: 8px; }
input, select { min-width: 0; padding: 8px; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); font: inherit; }
input:disabled { opacity: .55; }
</style>
