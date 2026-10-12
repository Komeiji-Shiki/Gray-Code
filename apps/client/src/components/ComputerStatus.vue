<script setup lang="ts">
import { shellText as t } from '../i18n';
import { onMounted, onUnmounted } from 'vue';
import { rpc as call } from '../api';
import { guard } from '../state';
import { computerState, connectComputer, openComputer } from '../computer';
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = connectComputer();
});
onUnmounted(() => unsubscribe?.());
</script>
<template>
  <div v-if="computerState.status?.active || computerState.status?.pausedRunId" class="computer-status-strip" role="status">
    <span>{{ computerState.status.active ? t('uiComputerStatusComputerOperating') : t('uiComputerStatusComputerAwaitingPermission') }}</span>
    <span v-if="computerState.status.active" class="computer-stop-hint">{{ t('uiComputerStatusTakeoverShortcut') }}</span>
    <button @click="openComputer">{{ t('uiComputerStatusViewControls') }}</button>
    <button v-if="computerState.status.active" class="computer-emergency" @click="guard(() => call('computer.stop'))">{{ t('uiComputerPaneStopNow') }}</button>
  </div>
</template>
<style scoped>
.computer-status-strip {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 7px 12px;
  background: var(--gc-surface-sunken);
  border-bottom: 1px solid var(--gc-accent);
  flex-wrap: wrap;
  font-size: 12px;
}
.computer-status-strip > span:first-child {
  color: var(--gc-accent);
}
.computer-stop-hint {
  color: var(--gc-text-muted);
  flex: 1;
}
.computer-status-strip button {
  border-radius: var(--gc-radius-sm);
  padding: 5px 10px;
}
.computer-emergency {
  color: var(--gc-danger);
  border-color: var(--gc-danger-border);
}
</style>
