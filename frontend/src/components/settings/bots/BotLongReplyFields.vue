<script setup lang="ts">
import type { BotOutputSettings } from '../../../../../packages/contracts/src/settings';
import { t } from '../../../i18n';
defineProps<{ modelValue?: Partial<BotOutputSettings>; inherited: BotOutputSettings; allowForward: boolean; override?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Partial<BotOutputSettings> | undefined] }>();
</script>
<template>
  <label class="bot-long-reply">{{ t('desktop.bot.longReplies') }}
    <select :value="modelValue?.longReplies ?? (override ? '' : inherited.longReplies)"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value ? { ...modelValue, longReplies: ($event.target as HTMLSelectElement).value as BotOutputSettings['longReplies'] } : undefined)">
      <option v-if="override" value="">{{ t('desktop.bot.inherit') }}</option>
      <option value="split">{{ t('desktop.bot.output_split') }}</option><option value="file">{{ t('desktop.bot.output_file') }}</option>
      <option value="forward" :disabled="!allowForward">{{ t('desktop.bot.output_forward') }}</option>
    </select>
    <small>{{ t('desktop.bot.outputHint') }}</small>
  </label>
</template>
<style scoped>
.bot-long-reply { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
select { padding: 8px; font: inherit; background: var(--gc-surface-input); color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); }
small { color: var(--gc-text-muted); line-height: 1.7; }
</style>
