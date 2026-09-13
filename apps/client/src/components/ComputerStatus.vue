<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { call } from '../api';
import { guard } from '../state';
import { computerState, connectComputer, openComputer } from '../computer';
let unsubscribe: (() => void) | undefined;
onMounted(() => { unsubscribe = connectComputer(); });
onUnmounted(() => unsubscribe?.());
</script>
<template>
  <div v-if="computerState.status?.active || computerState.status?.pausedRunId" class="computer-status-strip" role="status">
    <span>{{ computerState.status.active ? '本机电脑正在执行操作' : '电脑操作已暂停，等待主人允许继续' }}</span>
    <span v-if="computerState.status.active" class="computer-stop-hint">移动鼠标、按键或 Ctrl+Alt+Esc 可接管</span>
    <button @click="openComputer">查看控制</button>
    <button v-if="computerState.status.active" class="computer-emergency" @click="guard(() => call('computer.stop'))">立即停止</button>
  </div>
</template>
<style scoped>
.computer-status-strip{display:flex;gap:12px;align-items:center;padding:7px 12px;background:var(--surface,#171a20);border-bottom:1px solid var(--accent,#72a8e5);flex-wrap:wrap;font-size:12px}.computer-status-strip>span:first-child{color:var(--accent,#72a8e5)}.computer-stop-hint{color:var(--muted,#a2a9b5);flex:1}.computer-status-strip button{border-radius:0;padding:5px 10px}.computer-emergency{color:#ffc8c8;border-color:#a54949}
</style>
