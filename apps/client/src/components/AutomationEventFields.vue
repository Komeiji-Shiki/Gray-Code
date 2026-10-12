<script setup lang="ts">
import { shellText as t } from '../i18n';
import type { AutomationOptions } from '@graycode/contracts';
import type { AutomationEventForm } from './automationEventForm';
const form = defineModel<AutomationEventForm>({ required: true });
defineProps<{ options: AutomationOptions }>();
</script>
<template>
  <fieldset class="event-fields">
    <legend>{{ t('uiAutomationEventFieldsTriggerConditions') }}</legend>
    <label>
      {{ t('uiAutomationEventFieldsEventSource') }}
      <select v-model="form.type" required :aria-label="t('uiAutomationEventFieldsEventSource')">
        <option value="" disabled>{{ t('uiAutomationEventFieldsSelectSource') }}</option>
        <option value="run_completed">{{ t('uiAutomationEventFieldsConversationTaskCompleted') }}</option>
        <option value="file_changed">{{ t('uiAutomationEventFieldsWorkspaceFileChanged') }}</option>
        <option value="node_online">{{ t('uiAutomationEventFieldsPairedDeviceConnected') }}</option>
      </select>
    </label>
    <label v-if="form.type === 'run_completed'">
      {{ t('uiAutomationEventFieldsSourceConversation') }}
      <select v-model="form.conversationId" required :aria-label="t('uiAutomationEventFieldsEventConversation')">
        <option value="" disabled>{{ t('uiAutomationEventFieldsSelectConversation') }}</option>
        <option v-for="row in options.eventConversations" :key="row.id" :value="row.id">{{ row.title }}</option>
      </select>
    </label>
    <template v-if="form.type === 'file_changed'">
      <label>
        {{ t('uiAutomationEventFieldsMonitoredWorkspace') }}
        <select v-model="form.workspaceId" required :aria-label="t('uiAutomationEventFieldsEventWorkspace')">
          <option value="" disabled>{{ t('uiAutomationEventFieldsSelectWorkspace') }}</option>
          <option v-for="row in options.workspaces" :key="row.id" :value="row.id">{{ row.name }}</option>
        </select>
      </label>
      <label>
        {{ t('uiAutomationEventFieldsMonitoredFile') }}
        <input v-model="form.path" required :placeholder="t('uiAutomationEventFieldsFilePathExample')" :aria-label="t('uiAutomationEventFieldsEventFile')" />
      </label>
      <label>
        {{ t('uiAutomationEventFieldsDebounceDelay') }}
        <input v-model="form.debounceMs" type="number" min="100" max="60000" step="1" required :aria-label="t('uiAutomationEventFieldsEventDebounceDelay')" />
        <small class="settings-help">{{ t('uiAutomationEventFieldsDebounceDelayHelp') }}</small>
      </label>
      <p>{{ t('uiAutomationEventFieldsFileMonitoringHelp') }}</p>
      <p>{{ t('uiAutomationEventFieldsFileLoopPreventionHelp') }}</p>
    </template>
    <label v-if="form.type === 'node_online'">
      {{ t('uiAutomationEventFieldsPairedDevice') }}
      <select v-model="form.peerId" required :aria-label="t('uiAutomationEventFieldsEventDevice')">
        <option value="" disabled>{{ t('uiAutomationEventFieldsSelectDevice') }}</option>
        <option v-for="row in options.eventPeers" :key="row.id" :value="row.id">{{ row.name }}</option>
      </select>
    </label>
    <label>
      {{ t('uiAutomationEventFieldsEventsWhileBusy') }}
      <select v-model="form.busyPolicy" required :aria-label="t('uiAutomationEventFieldsBusyEventPolicy')">
        <option value="" disabled>{{ t('uiAutomationEventFieldsSelectBusyPolicy') }}</option>
        <option value="skip">{{ t('uiAutomationEventFieldsSkipAndRecordReason') }}</option>
        <option value="latest">{{ t('uiAutomationEventFieldsCoalesceLatestEvent') }}</option>
      </select>
    </label>
    <label>
      {{ t('uiAutomationEventFieldsAfterRestart') }}
      <select v-model="form.restartPolicy" required :aria-label="t('uiAutomationEventFieldsRestartEventPolicy')">
        <option value="" disabled>{{ t('uiAutomationEventFieldsSelectBusyPolicy') }}</option>
        <option value="pause">{{ t('uiAutomationEventFieldsPauseAfterRestart') }}</option>
        <option value="resume">{{ t('uiAutomationEventFieldsResumeAfterRestart') }}</option>
      </select>
    </label>
    <p>{{ t('uiAutomationEventFieldsRestartPauseHelp') }}</p>
  </fieldset>
</template>
<style scoped>
.event-fields {
  min-width: 0;
  margin: 0;
  border: 1px solid var(--gc-border-subtle);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
legend,
label {
  font-size: 13px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
input,
select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  font: inherit;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
}
p {
  margin: 0;
  color: var(--gc-text-muted);
  font-size: 12px;
  line-height: 1.65;
}
</style>
