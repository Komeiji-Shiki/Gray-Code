<script setup lang="ts">
import type { DiscordTrigger } from '../../../../../packages/contracts/src/settings';
import { t } from '../../../i18n';
const props = defineProps<{ modelValue: { trigger?: DiscordTrigger; keywords?: string[] }; inherited: DiscordTrigger; override?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: { trigger?: DiscordTrigger; keywords?: string[] }] }>();
const triggers: DiscordTrigger[] = ['mention', 'reply', 'mention_or_reply', 'keyword', 'all', 'command'];
</script>
<template>
  <section class="bot-triggers">
    <label>{{ t(override ? 'desktop.bot.trigger' : 'desktop.bot.defaultTrigger') }}
      <select :value="modelValue.trigger ?? (override ? '' : inherited)" @change="emit('update:modelValue', { ...modelValue, trigger: (($event.target as HTMLSelectElement).value || undefined) as DiscordTrigger | undefined })">
        <option v-if="override" value="">{{ t('desktop.bot.inherit') }}</option>
        <option v-for="trigger in triggers.filter(value => override || value !== 'keyword')" :key="trigger" :value="trigger">{{ t(`desktop.bot.trigger_${trigger}`) }}</option>
      </select>
    </label>
    <label v-if="(modelValue.trigger ?? inherited) === 'keyword'">{{ t('desktop.bot.keywords') }}
      <textarea rows="3" :value="modelValue.keywords?.join('\n') ?? ''" @input="emit('update:modelValue', { ...modelValue, keywords: ($event.target as HTMLTextAreaElement).value.split('\n').map(value => value.trim()).filter(Boolean) })" />
    </label>
  </section>
</template>
<style scoped>
.bot-triggers { margin: 16px 0; }
label { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
select, textarea { padding: 8px; font: inherit; background: var(--gc-surface-input); color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); }
</style>
