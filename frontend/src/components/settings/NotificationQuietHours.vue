<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import type { NotificationQuietHours } from '@shared/notificationPolicy'

const props = defineProps<{ modelValue: NotificationQuietHours }>()
const emit = defineEmits<{ 'update:modelValue': [value: NotificationQuietHours] }>()
const { t } = useI18n()
const label = (key: string) => t(`components.settings.soundSettings.quietHours.${key}`)
const mode = computed({ get: () => props.modelValue.mode, set: value => emit('update:modelValue', { ...props.modelValue, mode: value }) })
function edit(field: 'start' | 'end' | 'timeZone', event: Event) {
  emit('update:modelValue', { ...props.modelValue, [field]: (event.target as HTMLInputElement).value })
}
function localZone() { emit('update:modelValue', { ...props.modelValue, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }
</script>

<template>
  <section class="notification-quiet-hours" data-search-anchor="quiet-hours">
    <h3>{{ label('title') }}</h3>
    <p>{{ label('description') }}</p>
    <label>{{ label('mode') }}<select v-model="mode" :aria-label="label('mode')">
      <option value="off">{{ label('off') }}</option><option value="always">{{ label('always') }}</option><option value="schedule">{{ label('schedule') }}</option>
    </select></label>
    <div v-if="mode === 'schedule'" class="quiet-fields">
      <label>{{ label('start') }}<input type="time" :value="modelValue.start" :aria-label="label('start')" @input="edit('start', $event)"></label>
      <label>{{ label('end') }}<input type="time" :value="modelValue.end" :aria-label="label('end')" @input="edit('end', $event)"></label>
      <label class="zone">{{ label('zone') }}<input :value="modelValue.timeZone" placeholder="Asia/Shanghai" :aria-label="label('zone')" @input="edit('timeZone', $event)"></label>
      <button type="button" @click="localZone">{{ label('localZone') }}</button>
    </div>
  </section>
</template>

<style scoped>
.notification-quiet-hours { border: 1px solid var(--vscode-panel-border); padding: 16px; margin-bottom: 16px; }
h3 { margin: 0 0 8px; font-size: 14px; } p { color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 0 0 12px; }
label { display: flex; flex-direction: column; gap: 6px; min-width: 0; } select, input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 0; padding: 7px 9px; min-width: 0; }
.quiet-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; } .zone { grid-column: 1 / -1; } button { justify-self: start; grid-column: 1 / -1; cursor: pointer; }
</style>
