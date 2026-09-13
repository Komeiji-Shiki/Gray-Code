<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { ScreenSenseStatus } from '@graycode/contracts';
import { call, subscribe } from '../api';
const emit = defineEmits<{ manage: [] }>();
const status = ref<ScreenSenseStatus>(), error = ref('');
let unsubscribe: (() => void) | undefined;
onMounted(() => { void call<ScreenSenseStatus>('screenSense.status').then(value => { status.value = value; }).catch(() => {}); unsubscribe = subscribe(event => { if (event.type === 'screenSense.changed') status.value = event.status; }); });
onBeforeUnmount(() => unsubscribe?.());
async function stop() { try { status.value = await call('screenSense.stop'); error.value = ''; } catch (cause) { error.value = (cause as Error).message; } }
</script>
<template><section v-if="status?.active || error" class="screen-sense-status" aria-label="屏幕感知状态"><span :title="status?.target">屏幕感知 · {{ status?.target }}</span><button @click="emit('manage')">查看设置</button><button @click="stop">停止采集</button><span v-if="error" role="alert">{{ error }}</span></section></template>
<style scoped>.screen-sense-status{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--panel);font-size:12px;color:var(--text);flex-wrap:wrap}.screen-sense-status>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.screen-sense-status button{border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);font:inherit;padding:4px 7px;cursor:pointer;-webkit-app-region:no-drag}</style>
