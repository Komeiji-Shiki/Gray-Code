<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed } from 'vue';
import { call } from '../api';
import { debugState, debugAlive, debugControl } from '../debugging';
const emit = defineEmits<{ details: [] }>();
const sessions = computed(() => debugState.sessions.filter(debugAlive));
const active = computed(() => debugState.sessions.find((value) => value.id === debugState.activeId));
const root = computed(() => debugState.sessions.find((value) => value.id === active.value?.rootId));
const stopped = computed(() => active.value?.status === 'stopped' && !debugState.controlling);
const ready = computed(() => active.value && ['running', 'stopped'].includes(active.value.status) && !debugState.controlling);
</script>
<template>
  <div v-if="sessions.length" class="debug-controls" :aria-label="t('uiDebugControlsDebugControls')">
    <select v-model="debugState.activeId" :aria-label="t('uiDebugControlsCurrentDebugSession')">
      <option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.parentId ? '↳ ' : '' }}{{ session.name }}</option>
    </select>
    <button :disabled="!ready" @click="debugControl(stopped ? 'continue' : 'pause')">
      {{ stopped ? t('uiDebugControlsContinue') : t('uiDebugControlsPause') }}
    </button>
    <button :disabled="!stopped" :title="t('uiDebugControlsStepOverShortcut')" @click="debugControl('next')">{{ t('uiDebugControlsStepOver') }}</button>
    <button :disabled="!stopped" :title="t('uiDebugControlsStepIntoShortcut')" @click="debugControl('stepIn')">{{ t('uiDebugControlsStepInto') }}</button>
    <button :disabled="!stopped" :title="t('uiDebugControlsStepOutShortcut')" @click="debugControl('stepOut')">{{ t('uiDebugControlsStepOut') }}</button>
    <button :disabled="!ready" @click="debugControl('restart')">{{ t('uiDebugControlsRestart') }}</button>
    <button @click="debugControl('stop')">{{ root?.request === 'attach' ? t('uiDebugControlsDetach') : t('uiDebugControlsStop') }}</button>
    <button v-if="root?.terminalId" @click="call('debug.terminal', { id: debugState.activeId }).catch((error) => (debugState.error = String(error)))">
      {{ t('uiDebugControlsProgramTerminal') }}
    </button>
    <button class="debug-details" @click="emit('details')">{{ t('uiDebugControlsDebugDetails') }}</button>
  </div>
</template>
<style scoped>
.debug-controls {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  flex-wrap: wrap;
  padding: 5px 9px;
  border-bottom: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-raised);
  font-size: 12px;
}
.debug-controls select {
  flex: 1;
  min-width: 100px;
  max-width: 250px;
  background: var(--gc-surface-raised);
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  padding: 5px;
}
.debug-controls button {
  background: transparent;
  color: var(--gc-text-primary);
  border: 0;
  border-radius: var(--gc-radius-sm);
  font: inherit;
  padding: 5px 7px;
  cursor: pointer;
}
.debug-controls button:hover {
  background: var(--gc-surface-hover);
}
.debug-controls button:disabled {
  opacity: 0.4;
  cursor: default;
}
.debug-details {
  margin-left: auto;
}
</style>
