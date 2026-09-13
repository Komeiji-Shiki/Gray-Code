<script setup lang="ts">
import { computed } from 'vue';
import { call } from '../api';
import { debugState, debugAlive, debugControl } from '../debugging';
const emit = defineEmits<{ details: [] }>();
const sessions = computed(() => debugState.sessions.filter(debugAlive));
const active = computed(() => debugState.sessions.find(value => value.id === debugState.activeId));
const root = computed(() => debugState.sessions.find(value => value.id === active.value?.rootId));
const stopped = computed(() => active.value?.status === 'stopped' && !debugState.controlling);
const ready = computed(() => active.value && ['running', 'stopped'].includes(active.value.status) && !debugState.controlling);
</script>
<template>
  <div v-if="sessions.length" class="debug-controls" aria-label="调试控制">
    <select v-model="debugState.activeId" aria-label="当前调试会话"><option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.parentId ? '↳ ' : '' }}{{ session.name }}</option></select>
    <button :disabled="!ready" @click="debugControl(stopped ? 'continue' : 'pause')">{{ stopped ? '继续' : '暂停' }}</button>
    <button :disabled="!stopped" title="单步跳过（F10）" @click="debugControl('next')">跳过</button>
    <button :disabled="!stopped" title="单步进入（F11）" @click="debugControl('stepIn')">进入</button>
    <button :disabled="!stopped" title="单步跳出（Shift+F11）" @click="debugControl('stepOut')">跳出</button>
    <button :disabled="!ready" @click="debugControl('restart')">重启</button>
    <button @click="debugControl('stop')">{{ root?.request === 'attach' ? '分离' : '停止' }}</button>
    <button v-if="root?.terminalId" @click="call('debug.terminal', { id: debugState.activeId }).catch(error => debugState.error = String(error))">程序终端</button>
    <button class="debug-details" @click="emit('details')">调试详情</button>
  </div>
</template>
<style scoped>
.debug-controls{display:flex;align-items:center;gap:3px;min-width:0;flex-wrap:wrap;padding:5px 9px;border-bottom:1px solid var(--border);background:var(--panel);font-size:12px}.debug-controls select{flex:1;min-width:100px;max-width:250px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:0;padding:5px}.debug-controls button{background:transparent;color:var(--text);border:0;border-radius:0;font:inherit;padding:5px 7px;cursor:pointer}.debug-controls button:hover{background:var(--hover)}.debug-controls button:disabled{opacity:.4;cursor:default}.debug-details{margin-left:auto}
</style>
