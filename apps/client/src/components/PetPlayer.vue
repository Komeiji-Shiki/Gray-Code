<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import {
  PET_DEFAULT_DURATION_MS, PET_HEARTBEAT_INTERVAL_MS, type PetCommand, type PetCommandInput,
  type PetConfiguration, type PetControls, type PetParameter, type PetRenderState, type PetResource, type PetRuntime,
} from '@graycode/contracts';
import { rpc } from '../api';
import { shellText } from '../i18n';
import type { PetRenderPayload, PetRendererMessage } from '../pets/protocol';
import { PetRequests } from '../pets/requests';
import { petRenderPayload } from '../pets/assets';

const props = defineProps<{
  resource: PetResource;
  configuration: PetConfiguration;
  runtime?: PetRuntime;
  state?: PetRenderState;
  controlled?: boolean;
}>();
const emit = defineEmits<{ ready: [parameters: PetParameter[]]; failed: [message: string] }>();
const frame = ref<HTMLIFrameElement>();
const container = ref<HTMLDivElement>();
const error = ref('');
const ready = ref(false);
const rendererId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const generation = props.state?.generation ?? sessionId;
const source = new URL('pet-renderer.html', location.href).href;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let observer: ResizeObserver | undefined;
let connected = false;
let started = false;
let closed = false;
let claimed = false;
let payload: PetRenderPayload | undefined;
let lastApply = '';
let speech: SpeechSynthesisUtterance | undefined;
let mouthTimer: ReturnType<typeof setInterval> | undefined;
const requests = new PetRequests();
const identity = () => ({ rendererId, generation });

function post(value: Record<string, unknown>, transfer: Transferable[] = []) {
  frame.value?.contentWindow?.postMessage({ type: 'graycode.pet.host', sessionId, ...value }, '*', transfer);
}
function start() {
  if (!connected || !payload || started || closed) return;
  started = true;
  const transfer: Transferable[] = payload.bundle.files.map(file => file.bytes);
  if (payload.runtime) transfer.push(payload.runtime);
  post({ action: 'load', payload }, transfer);
  payload = undefined;
}
function commandPayload(command: PetCommand | undefined): PetCommand | null {
  return command ? { ...command, ...(command.parameters ? { parameters: { ...command.parameters } } : {}) } : null;
}
function configurationPayload(): PetConfiguration {
  return {
    ...props.configuration, mappings: { ...props.configuration.mappings },
    ...(props.configuration.position ? { position: { ...props.configuration.position } } : {}),
  };
}
function current(force = false) {
  if (!ready.value || !props.controlled) return;
  const controls: PetControls = Object.fromEntries(Object.entries(props.state?.channels ?? {})
    .map(([channel, command]) => [channel, commandPayload(command)]));
  const configuration = configurationPayload();
  const command = commandPayload(props.state?.current);
  const value = JSON.stringify({ command, controls, configuration });
  if (!force && value === lastApply) return;
  lastApply = value;
  post({ action: 'apply', command, controls, configuration });
}
function failed(message: string) {
  if (closed) return;
  error.value = message;
  requests.rejectAll(new Error(message));
  emit('failed', message);
}
async function message(event: MessageEvent) {
  if (closed || event.source !== frame.value?.contentWindow || event.data?.type !== 'graycode.pet.renderer') return;
  const value = event.data as PetRendererMessage;
  if (value.event === 'connected') {
    connected = true;
    start();
    return;
  }
  if (value.sessionId !== sessionId) return;
  try {
    if (value.event === 'ready') {
      if (props.controlled) await rpc('pets.renderer.ready', { ...identity(), parameters: value.parameters });
      if (closed) return;
      ready.value = true;
      const bounds = container.value?.getBoundingClientRect();
      if (bounds) post({
        action: 'resize', width: Math.round(bounds.width * devicePixelRatio), height: Math.round(bounds.height * devicePixelRatio),
      });
      emit('ready', value.parameters);
      if (props.controlled) current(true);
      else post({ action: 'apply', command: null, controls: {}, configuration: configurationPayload() });
    } else if (value.event === 'closed') {
      ready.value = false;
      failed(shellText('petPlayerClosed'));
      if (props.controlled) await rpc('pets.renderer.closed', identity());
    } else if (value.event === 'failed') {
      ready.value = false;
      failed(value.error);
      if (props.controlled) await rpc('pets.renderer.failed', { ...identity(), error: value.error });
    } else if (value.event === 'applied') {
      if (value.requestId) {
        requests.settle(value.requestId, value.success ? undefined : new Error(value.error));
        if (props.controlled) await rpc('pets.renderer.applied', {
          ...identity(), requestId: value.requestId, success: value.success, error: value.error,
        });
      }
      if (!closed) error.value = value.success ? '' : value.error ?? shellText('petApplyFailed');
    } else if (value.event === 'hit' && !props.configuration.stopped) {
      const area = props.resource.hitAreas?.find(area => value.areas.includes(area.name));
      const motion = area?.motion ?? props.resource.actions.find(action =>
        action.group?.toLowerCase() === ('tap' + area?.name).toLowerCase())?.id;
      if (!motion) return;
      if (props.controlled) {
        const result = await rpc('pets.command', { command: { action: 'play', id: motion } });
        if (!result.success) error.value = result.error ?? shellText('petApplyFailed');
      } else await apply({ action: 'play', id: motion });
    }
  } catch (cause) {
    failed((cause as Error).message);
  }
}
function apply(command: PetCommandInput | null, signal?: AbortSignal): Promise<void> {
  if (closed || !ready.value) return Promise.reject(new Error(shellText('petPreviewNotReady')));
  if (signal?.aborted) return Promise.reject(new Error(shellText('petRequestCancelled')));
  const requestId = crypto.randomUUID();
  error.value = '';
  const result = requests.wait(requestId, signal);
  try {
    post({
      action: 'apply',
      command: {
        ...(command ?? { action: 'cancel' }), requestId, generation, resourceId: props.resource.id,
        source: 'manual', actorId: 'preview', createdAt: Date.now(),
        expiresAt: Date.now() + (command?.durationMs ?? PET_DEFAULT_DURATION_MS),
      },
      configuration: configurationPayload(),
    });
  } catch (cause) {
    requests.settle(requestId, cause instanceof Error ? cause : new Error(String(cause)));
  }
  return result;
}
let pointerFrame: number | undefined;
let pointerPosition = { x: 0, y: 0, leave: false };
function pointer(x: number, y: number, leave = false) {
  if (closed || !ready.value || props.configuration.followPointer === false) return;
  pointerPosition = { x, y, leave };
  if (pointerFrame !== undefined) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = undefined;
    if (closed || !ready.value || props.configuration.followPointer === false) return;
    const bounds = frame.value?.getBoundingClientRect();
    if (!bounds) return;
    post({ action: 'pointer', x: (pointerPosition.x - bounds.left) * devicePixelRatio,
      y: (pointerPosition.y - bounds.top) * devicePixelRatio, leave: pointerPosition.leave });
  });
}
function trackPointer(event: PointerEvent) { pointer(event.clientX, event.clientY, event.type === 'pointerleave'); }
function stopSpeech() {
  clearInterval(mouthTimer);
  mouthTimer = undefined;
  if (speech && window.speechSynthesis) window.speechSynthesis.cancel();
  speech = undefined;
  if (!closed) post({ action: 'mouth', value: 0 });
}
function speak(text: string) {
  if (!props.configuration.speechEnabled || props.configuration.stopped || !text.trim()) return;
  if (!window.speechSynthesis) { error.value = shellText('petSpeechUnavailable'); return; }
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  speech = utterance;
  utterance.lang = document.documentElement.lang || navigator.language;
  utterance.onstart = () => {
    const startedAt = performance.now();
    // 系统语音不提供音素或波形，只用播放节奏生成近似口型，并在结束后恢复模型本身的参数。
    mouthTimer = setInterval(() => post({
      action: 'mouth', value: Math.abs(Math.sin((performance.now() - startedAt) / 105)) * 0.8,
    }), 80);
  };
  const finish = () => {
    if (speech !== utterance) return;
    clearInterval(mouthTimer);
    mouthTimer = undefined;
    speech = undefined;
    post({ action: 'mouth', value: 0 });
  };
  utterance.onend = finish;
  utterance.onerror = event => {
    finish();
    if (event.error !== 'canceled' && event.error !== 'interrupted') error.value = shellText('petSpeechUnavailable');
  };
  window.speechSynthesis.speak(utterance);
}
watch(() => [props.state?.channels, props.state?.current, props.configuration], () => {
  if (props.configuration.stopped || !props.configuration.speechEnabled) stopSpeech();
  if (props.controlled) current();
  else if (ready.value) post({ action: 'apply', configuration: configurationPayload() });
}, { deep: true });
onMounted(async () => {
  window.addEventListener('message', message);
  window.addEventListener('pointermove', trackPointer);
  window.addEventListener('pointerleave', trackPointer);
  try {
    if (props.controlled) {
      await rpc('pets.renderer.claim', { ...identity(), surface: props.configuration.surface });
      claimed = true;
      if (closed) return;
      heartbeat = setInterval(() => void rpc('pets.renderer.heartbeat', identity())
        .catch(cause => failed(cause.message)), PET_HEARTBEAT_INTERVAL_MS);
    }
    const loaded = await petRenderPayload(structuredClone(toRaw(props.resource)), props.runtime);
    // 切换资源或关闭预览后，迟到的加载结果不能再创建观察器。
    if (closed) return;
    payload = loaded;
    start();
    observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) post({
        action: 'resize', width: Math.max(1, Math.round(bounds.width * devicePixelRatio)),
        height: Math.max(1, Math.round(bounds.height * devicePixelRatio)),
      });
    });
    if (container.value) observer.observe(container.value);
  } catch (cause) {
    failed((cause as Error).message);
    if (claimed && !closed) void rpc('pets.renderer.failed', { ...identity(), error: (cause as Error).message }).catch(() => {});
  }
});
onBeforeUnmount(() => {
  stopSpeech();
  closed = true;
  if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
  observer?.disconnect();
  clearInterval(heartbeat);
  window.removeEventListener('message', message);
  window.removeEventListener('pointermove', trackPointer);
  window.removeEventListener('pointerleave', trackPointer);
  requests.rejectAll(new Error(shellText('petPreviewClosed')));
  if (props.controlled) void rpc('pets.renderer.closed', identity()).catch(() => {});
});

defineExpose({ apply, ready, speak, pointer });
</script>
<template>
  <div ref="container" class="pet-player" :data-ready="ready" :data-resource="resource.id">
    <iframe ref="frame" :src="source" sandbox="allow-scripts" allow="autoplay" :title="shellText('petCanvasTitle').replace('{name}', resource.name)" />
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!ready" role="status">{{ shellText('petLoading').replace('{name}', resource.name) }}</p>
  </div>
</template>
<style scoped>
.pet-player {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 80px;
}
.pet-player iframe {
  color-scheme: normal;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  display: block;
}
.pet-player p {
  position: absolute;
  inset: auto 8px 8px;
  padding: 8px;
  background: var(--gc-surface-overlay);
  color: var(--gc-danger);
  font: 12px/1.7 sans-serif;
  margin: 0;
  pointer-events: none;
}
</style>
