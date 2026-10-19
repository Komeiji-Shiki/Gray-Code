<script setup lang="ts">
import type { DiscordTrigger } from '../../../../../packages/contracts/src/settings';
import { t } from '../../../i18n';
const props = defineProps<{ modelValue: { trigger?: DiscordTrigger; keywords?: string[] }; inherited: DiscordTrigger; override?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: { trigger?: DiscordTrigger; keywords?: string[] }] }>();
const triggers: DiscordTrigger[] = ['mention', 'reply', 'mention_or_reply', 'keyword', 'all', 'command'];
</script>
<template>
  <section class="bot-triggers">
    <label><span>{{ t(override ? 'desktop.bot.trigger' : 'desktop.bot.defaultTrigger') }}</span>
      <select :value="modelValue.trigger ?? (override ? '' : inherited)" @change="emit('update:modelValue', { ...modelValue, trigger: (($event.target as HTMLSelectElement).value || undefined) as DiscordTrigger | undefined })">
        <option v-if="override" value="">{{ t('desktop.bot.inherit') }}</option>
        <option v-for="trigger in triggers.filter(value => override || value !== 'keyword')" :key="trigger" :value="trigger">{{ t(`desktop.bot.trigger_${trigger}`) }}</option>
      </select>
    </label>
    <label v-if="(modelValue.trigger ?? inherited) === 'keyword'" class="bot-full"><span>{{ t('desktop.bot.keywords') }}</span>
      <textarea rows="3" :value="modelValue.keywords?.join('\n') ?? ''" @input="emit('update:modelValue', { ...modelValue, keywords: ($event.target as HTMLTextAreaElement).value.split('\n').map(value => value.trim()).filter(Boolean) })" />
    </label>
  </section>
</template>
<style scoped>
.bot-triggers { margin: 4px 0 8px; }
.bot-triggers>label { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 0; }
.bot-triggers>label>span { width: 42%; min-width: 0; }
.bot-triggers select, .bot-triggers textarea { padding: 9px 10px; font: inherit; background: var(--gc-surface-input); color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); }
.bot-triggers select { width: 54%; min-width: 0; }
.bot-triggers>.bot-full { flex-direction: column; align-items: stretch; gap: 8px; }
.bot-triggers>.bot-full textarea { width: 100%; box-sizing: border-box; line-height: 1.6; resize: vertical; }
@media (max-width: 650px) {
  .bot-triggers>label { align-items: flex-start; flex-wrap: wrap; gap: 10px; }
  .bot-triggers>label>span { width: auto; flex: 1; }
  .bot-triggers select { width: 100%; }
}
</style>
