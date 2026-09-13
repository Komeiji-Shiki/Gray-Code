<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PetCommandInput, PetConfiguration, PetParameter, PetRenderState, PetResource } from '@graycode/contracts';
import { call } from '../api';
import type { PetRenderPayload } from '../pets/protocol';
const props = defineProps<{ resource: PetResource; configuration: PetConfiguration; state?: PetRenderState; controlled?: boolean }>();
const emit = defineEmits<{ ready: [parameters: PetParameter[]]; failed: [message: string] }>();
const frame = ref<HTMLIFrameElement>(), container = ref<HTMLDivElement>(), error = ref(''), ready = ref(false);
const rendererId = crypto.randomUUID(), sessionId = crypto.randomUUID();
const generation = props.state?.generation;
const source = new URL('pet-renderer.html', location.href).href;
let heartbeat: ReturnType<typeof setInterval> | undefined, observer: ResizeObserver | undefined;
let connected = false, started = false, closed = false, payload: PetRenderPayload | undefined, lastApply = '';
const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
const identity = () => ({ rendererId, generation });
function post(value: Record<string, unknown>) { frame.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify({ type: 'graycode.pet.host', sessionId, ...value })), '*'); }
function start() { if (!connected || !payload || started || closed) return; started = true; post({ action: 'load', payload }); }
function current(force = false) {
  if (!ready.value || !props.controlled) return;
  const value = JSON.stringify({ command: props.state?.current ?? null, stopped: props.configuration.stopped, reducedMotion: props.configuration.reducedMotion });
  if (!force && value === lastApply) return; lastApply = value;
  post({ action: 'apply', command: props.state?.current ?? null, configuration: props.configuration });
}
function failed(message: string) { error.value = message; emit('failed', message); }
async function message(event: MessageEvent) {
  if (closed || event.source !== frame.value?.contentWindow || event.data?.type !== 'graycode.pet.renderer') return;
  const value = event.data;
  if (value.event === 'connected') { connected = true; start(); return; }
  if (value.sessionId !== sessionId) return;
  try {
    if (value.event === 'ready') {
      if (props.controlled) await call('pets.renderer.ready', { ...identity(), parameters: value.parameters });
      ready.value = true; const bounds = container.value?.getBoundingClientRect(); if (bounds) post({ action: 'resize', width: Math.round(bounds.width * devicePixelRatio), height: Math.round(bounds.height * devicePixelRatio) }); emit('ready', value.parameters); current(true);
    } else if (value.event === 'failed') {
      failed(String(value.error)); if (props.controlled) await call('pets.renderer.failed', { ...identity(), error: value.error });
    } else if (value.event === 'applied') {
      if (value.requestId && props.controlled) await call('pets.renderer.applied', { ...identity(), requestId: value.requestId, success: value.success === true, error: value.error });
      const waiting = pending.get(value.requestId);
      if (waiting) { pending.delete(value.requestId); if (value.success) waiting.resolve(); else waiting.reject(new Error(value.error)); }
      if (!value.success) failed(String(value.error));
    }
  } catch (cause) { failed((cause as Error).message); }
}
function apply(command: PetCommandInput | null): Promise<void> {
  if (!ready.value) return Promise.reject(new Error('桌宠预览尚未就绪。'));
  const requestId = crypto.randomUUID(); error.value = '';
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post({ action: 'apply', command: { ...(command ?? { action: 'cancel' }), requestId }, configuration: props.configuration });
  });
}
watch(() => [props.state?.current, props.configuration.stopped, props.configuration.reducedMotion], () => current(), { deep: true });
onMounted(async () => {
  window.addEventListener('message', message);
  try {
    if (props.controlled) {
      await call('pets.renderer.claim', { ...identity(), surface: props.configuration.surface });
      if (closed) return;
      heartbeat = setInterval(() => void call('pets.renderer.heartbeat', identity()).catch(cause => failed(cause.message)), 5000);
    }
    const [bundle, runtime] = await Promise.all([call('pets.bundle', { id: props.resource.id }), props.resource.kind === 'live2d' ? call('pets.runtime.get') : Promise.resolve(null)]);
    payload = { resource: props.resource, bundle, runtime: runtime?.data }; start();
    observer = new ResizeObserver(entries => { const bounds = entries[0]?.contentRect; if (bounds) post({ action: 'resize', width: Math.max(1, Math.round(bounds.width * devicePixelRatio)), height: Math.max(1, Math.round(bounds.height * devicePixelRatio)) }); });
    if (container.value) observer.observe(container.value);
  } catch (cause) { failed((cause as Error).message); }
});
onBeforeUnmount(() => {
  closed = true; observer?.disconnect(); clearInterval(heartbeat); window.removeEventListener('message', message);
  for (const waiting of pending.values()) waiting.reject(new Error('预览已经关闭。')); pending.clear();
  if (props.controlled) void call('pets.renderer.closed', identity()).catch(() => {});
});
defineExpose({ apply, ready });
</script>
<template><div ref="container" class="pet-player" :data-ready="ready" :data-resource="resource.id"><iframe ref="frame" :src="source" sandbox="allow-scripts" :title="resource.name + '桌宠画面'" /><p v-if="error" role="alert">{{ error }}</p><p v-else-if="!ready" role="status">正在加载{{ resource.name }}…</p></div></template>
<style scoped>.pet-player{position:relative;width:100%;height:100%;min-height:80px}.pet-player iframe{color-scheme:normal;width:100%;height:100%;border:0;background:transparent;display:block;pointer-events:none}.pet-player p{position:absolute;inset:auto 8px 8px;padding:8px;background:#111e;color:#e8c8c8;font:12px/1.7 sans-serif;margin:0}</style>
