<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, ref, watch, onUnmounted } from 'vue';
import type {
  ComputerAction,
  ComputerCapture,
  ComputerDisplayCapture,
  ComputerObservation,
  ComputerStatus,
  ComputerWindows,
  NodePeerSummary,
} from '@graycode/contracts';
import { call, subscribe } from '../api';
const props = defineProps<{ peer: NodePeerSummary; visible: boolean }>();
const inventory = ref<ComputerWindows>();
const observation = ref<ComputerObservation>();
const displayFrame = ref<ComputerDisplayCapture>();
const target = ref('');
const filter = ref('');
const status = ref<ComputerStatus>();
const viewing = ref(false);
const controlling = ref(false);
const fps = ref(1);
const width = ref(1280);
const format = ref<'png' | 'jpeg'>('png');
const pointerMode = ref<'click' | 'drag' | 'scroll'>('click');
const inputText = ref('');
const key = ref('Control+A');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const frameBusy = ref(false);
const pageVisible = ref(!document.hidden);
const roundTripMs = ref(0);
const receivedAt = ref(0);
const gesture = ref<{ x: number; y: number; time: number; observationId: string }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let epoch = 0;
let disposed = false;
let refreshingStatus: Promise<void> | undefined;
let targetPending = false;
const windowId = computed(() => (target.value.startsWith('window:') ? target.value.slice(7) : ''));
const monitorId = computed(() => (target.value.startsWith('display:') ? target.value.slice(8) : ''));
const image = computed<ComputerCapture | ComputerDisplayCapture | undefined>(() => displayFrame.value ?? observation.value?.screenshot);
const imageUrl = computed(() => (image.value ? `data:${image.value.mimeType};base64,${image.value.data}` : undefined));
const windows = computed(
  () =>
    inventory.value?.windows.filter(
      (value) => !filter.value || `${value.title} ${value.executable}`.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()),
    ) ?? [],
);
const enabled = computed(() => props.visible && pageVisible.value && props.peer.state === 'online');
const canInput = computed(() => enabled.value && controlling.value && status.value?.active && !!observation.value && !busy.value && !frameBusy.value);
const remote = <T = any,>(method: string, params: Record<string, unknown> = {}) => call<T>('nodes.request', { peerId: props.peer.id, method, params });
function clearTimer() {
  clearTimeout(timer);
  timer = undefined;
}
function schedule() {
  clearTimer();
  if (!disposed && enabled.value && viewing.value && target.value && !gesture.value && !busy.value && !frameBusy.value)
    timer = setTimeout(() => {
      void capture().catch(failed);
    }, 1000 / fps.value);
}
function currentView(generation: number) {
  return !disposed && enabled.value && generation === epoch;
}
function failed(cause: unknown) {
  if (disposed || !enabled.value) return;
  error.value = (cause as Error).message;
  viewing.value = false;
  gesture.value = undefined;
  clearTimer();
}
async function readSelectedTarget() {
  if (!targetPending || disposed || !enabled.value || busy.value || frameBusy.value) return;
  targetPending = false;
  const selected = target.value;
  await perform(async () => {
    await release();
    if (selected === target.value) await capture();
  });
}
async function refreshStatus() {
  if (refreshingStatus) return refreshingStatus;
  const generation = epoch;
  refreshingStatus = (async () => {
    const result = await remote<ComputerStatus>('computer.status');
    if (!currentView(generation)) return;
    status.value = result;
    if (!result.active) controlling.value = false;
  })().finally(() => {
    refreshingStatus = undefined;
  });
  return refreshingStatus;
}
async function load() {
  if (!enabled.value || !props.peer.capabilities?.computer) return;
  const generation = epoch;
  const value = await remote<ComputerWindows>('computer.windows');
  if (!currentView(generation)) return;
  inventory.value = value;
  await refreshStatus();
  if (
    currentView(generation) &&
    ((windowId.value && !value.windows.some((item) => item.id === windowId.value)) ||
      (monitorId.value && !value.displays.some((item) => item.id === monitorId.value)))
  )
    target.value = '';
}
async function capture(full = false) {
  if (!enabled.value || !target.value || frameBusy.value || gesture.value) return;
  const current = epoch;
  frameBusy.value = true;
  clearTimer();
  const started = performance.now();
  try {
    const params = { width: width.value, height: 2160, format: format.value, quality: 85 };
    if (windowId.value) {
      const result = await remote<ComputerObservation>('computer.observe', { windowId: windowId.value, screenshot: true, frameOnly: !full, ...params });
      if (current !== epoch || !enabled.value) return;
      observation.value = result;
      displayFrame.value = undefined;
    } else if (monitorId.value) {
      const result = await remote<ComputerDisplayCapture>('computer.display', { monitorId: monitorId.value, ...params });
      if (current !== epoch || !enabled.value) return;
      displayFrame.value = result;
      observation.value = undefined;
    }
    roundTripMs.value = Math.round(performance.now() - started);
    receivedAt.value = Date.now();
    error.value = '';
  } catch (cause) {
    if (current === epoch && enabled.value) throw cause;
  } finally {
    frameBusy.value = false;
    if (targetPending) void readSelectedTarget();
    else schedule();
  }
}
async function release() {
  controlling.value = false;
  gesture.value = undefined;
  epoch++;
  clearTimer();
  if (props.peer.state === 'online') await remote('computer.release');
  await refreshStatus();
  schedule();
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  clearTimer();
  try {
    await action();
  } catch (cause) {
    failed(cause);
  } finally {
    busy.value = false;
    if (targetPending) void readSelectedTarget();
    else schedule();
  }
}
async function acquire() {
  if (!enabled.value || !windowId.value) throw new Error(t('uiNodeScreenSelectTargetWindow'));
  const generation = ++epoch;
  const result = await remote<ComputerStatus>('computer.acquire', { windowIds: [windowId.value] });
  // 关闭、隐藏或更换目标后，迟到取得的控制权也必须释放。
  if (!currentView(generation)) {
    await remote('computer.release');
    return;
  }
  status.value = result;
  controlling.value = result.active;
  await capture();
}
async function executeAction(args: Omit<ComputerAction, 'observationId'>, observationId: string, generation: number) {
  let failure: unknown;
  try {
    await remote('computer.action', { ...args, observationId, operationId: crypto.randomUUID() });
  } catch (cause) {
    failure = cause;
  }
  if (!currentView(generation)) return;
  if (!failure) notice.value = t('uiNodeScreenActionCompleted');
  observation.value = undefined;
  try {
    await refreshStatus();
    if (currentView(generation)) await capture();
  } catch (cause) {
    // 保留动作本身的失败原因，截图失败不能覆盖已经收到的动作回执。
    failure ??= new Error(t('uiNodeScreenActionCompletedRefreshFailed', { value1: (cause as Error).message }));
  }
  if (failure && currentView(generation)) throw failure;
}
async function focusWindow() {
  if (!enabled.value || !controlling.value || !windowId.value) throw new Error(t('uiNodeScreenWindowControlRequired'));
  const generation = epoch;
  // 最小化或尚无截图的窗口，也能通过新鲜的窗口身份恢复并切换焦点。
  const current = await remote<ComputerObservation>('computer.observe', { windowId: windowId.value, frameOnly: true });
  if (!currentView(generation) || !controlling.value) return;
  await executeAction({ action: 'focusWindow' }, current.id, generation);
}
async function action(args: Omit<ComputerAction, 'observationId'>, capturedId?: string) {
  const current = observation.value;
  if (!enabled.value || !controlling.value || !current || (capturedId && current.id !== capturedId)) throw new Error(t('uiNodeScreenScreenChanged'));
  await executeAction(args, current.id, epoch);
}
function point(event: PointerEvent | WheelEvent) {
  const current = image.value;
  if (!current) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = ((event.clientX - rect.left) * current.width) / rect.width,
    y = ((event.clientY - rect.top) * current.height) / rect.height;
  if (x < 0 || y < 0 || x >= current.width || y >= current.height) return;
  return { x, y };
}
function pointerDown(event: PointerEvent) {
  if (!canInput.value || event.button !== 0) return;
  const start = point(event);
  if (!start || !observation.value) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.focus({ preventScroll: true });
  element.setPointerCapture(event.pointerId);
  gesture.value = { ...start, time: performance.now(), observationId: observation.value.id };
  clearTimer();
}
function pointerUp(event: PointerEvent) {
  const start = gesture.value,
    end = point(event);
  gesture.value = undefined;
  if (!start || !end || !canInput.value) {
    schedule();
    return;
  }
  event.preventDefault();
  const distance = Math.hypot(start.x - end.x, start.y - end.y);
  const args: Omit<ComputerAction, 'observationId'> =
    pointerMode.value === 'scroll'
      ? { action: 'scroll', coordinateSpace: 'image', x: start.x, y: start.y, scrollY: Math.max(-20, Math.min(20, Math.round((start.y - end.y) / 30))) }
      : pointerMode.value === 'drag' && distance > 4
        ? {
            action: 'drag',
            coordinateSpace: 'image',
            x: start.x,
            y: start.y,
            toX: end.x,
            toY: end.y,
            durationMs: Math.max(100, Math.min(5000, performance.now() - start.time)),
          }
        : { action: 'click', coordinateSpace: 'image', ...end };
  void perform(() => action(args, start.observationId));
}
function wheel(event: WheelEvent) {
  if (!canInput.value) return;
  const position = point(event);
  if (!position) return;
  event.preventDefault();
  clearTimer();
  void perform(() =>
    action({ action: 'scroll', coordinateSpace: 'image', ...position, scrollY: Math.sign(event.deltaY) * 3, scrollX: Math.sign(event.deltaX) * 3 }),
  );
}
function keyboard(event: KeyboardEvent) {
  if (!canInput.value || event.isComposing || event.metaKey || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key) || event.repeat) return;
  const name = event.key.length === 1 && /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key;
  if (!/^(?:[A-Z0-9]|F\d{1,2}|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space)$/.test(name))
    return;
  event.preventDefault();
  const combo = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', name].filter(Boolean).join('+');
  void perform(() => action({ action: 'key', key: combo }));
}
function visibility() {
  pageVisible.value = !document.hidden;
}
watch(target, () => {
  epoch++;
  observation.value = undefined;
  displayFrame.value = undefined;
  targetPending = true;
  void readSelectedTarget();
});
watch([fps, width, format], () => {
  epoch++;
  schedule();
});
watch(viewing, schedule);
watch(
  enabled,
  (value) => {
    epoch++;
    clearTimer();
    gesture.value = undefined;
    if (value) {
      targetPending = !!target.value;
      void perform(load);
    } else {
      targetPending = false;
      viewing.value = false;
      controlling.value = false;
      if (props.peer.state === 'online') void remote('computer.release').catch(() => {});
    }
  },
  { immediate: true },
);
const off = subscribe((event) => {
  if (enabled.value && event.type === 'nodes.event' && event.peerId === props.peer.id && event.notification?.type === 'computer.changed')
    void refreshStatus().catch(failed);
});
document.addEventListener('visibilitychange', visibility);
onUnmounted(() => {
  disposed = true;
  epoch++;
  viewing.value = false;
  clearTimer();
  off();
  document.removeEventListener('visibilitychange', visibility);
  if (props.peer.state === 'online') void remote('computer.release').catch(() => {});
});
</script>
<template>
  <div class="node-screen">
    <p v-if="!peer.capabilities?.computer" class="node-empty">{{ t('uiNodeScreenComputerControlUnavailable') }}</p>
    <template v-else>
      <p v-if="peer.capabilities?.visual" class="node-hint">{{ t('uiNodeScreenPixelControlHelp') }}</p>
      <div class="node-screen-controls">
        <label>
          {{ t('uiNodeScreenWindowFilter') }}
          <input v-model="filter" :placeholder="t('uiNodeScreenWindowFilterPlaceholder')" :aria-label="t('uiNodeScreenRemoteWindowFilter')" />
        </label>
        <label>
          {{ t('uiNodeScreenViewingTarget') }}
          <select v-model="target" :aria-label="t('uiNodeScreenRemoteViewingTarget')">
            <option value="">{{ t('uiNodeScreenSelectWindowOrDisplay') }}</option>
            <optgroup :label="t('uiComputerPaneWindow')">
              <option v-for="value in windows" :key="value.id" :value="`window:${value.id}`">{{ value.title }} · PID {{ value.processId }}</option>
            </optgroup>
            <optgroup :label="t('uiNodeScreenDisplayPreview')">
              <option v-for="value in inventory?.displays" :key="value.id" :value="`display:${value.id}`">
                {{ value.id }} · {{ value.bounds.width }}×{{ value.bounds.height }}
              </option>
            </optgroup>
          </select>
        </label>
        <button :disabled="busy || !enabled" @click="perform(load)">{{ t('uiNodeScreenRefreshWindows') }}</button>
      </div>
      <div class="node-screen-controls">
        <label class="node-check">
          <input v-model="viewing" type="checkbox" :disabled="!enabled || !target" :aria-label="t('uiNodeScreenContinuousViewingHelp')" />
          {{ t('uiNodeScreenContinuousViewing') }}
        </label>
        <label>
          {{ t('uiNodeScreenFrameRate') }}
          <select v-model.number="fps" :aria-label="t('uiNodeScreenRemoteFrameRate')">
            <option :value="1">{{ t('uiNodeScreenFrameRateOne') }}</option>
            <option :value="2">{{ t('uiNodeScreenFrameRateTwo') }}</option>
            <option :value="5">{{ t('uiNodeScreenFrameRateFive') }}</option>
          </select>
        </label>
        <label>
          {{ t('uiNodeScreenScreenWidth') }}
          <select v-model.number="width">
            <option :value="960">{{ t('uiNodeScreenScreenWidthSmall') }}</option>
            <option :value="1280">{{ t('uiNodeScreenScreenWidthMedium') }}</option>
            <option :value="1920">{{ t('uiNodeScreenScreenWidthLarge') }}</option>
          </select>
        </label>
        <label>
          {{ t('uiNodeScreenImageFormat') }}
          <select v-model="format">
            <option value="png">{{ t('uiNodeScreenLosslessPng') }}</option>
            <option value="jpeg">JPEG</option>
          </select>
        </label>
        <button :disabled="busy || frameBusy || !enabled || !target" @click="perform(() => capture())">
          {{ frameBusy ? t('uiNodeScreenCapturing') : t('uiNodeScreenCaptureFrame') }}
        </button>
      </div>
      <p class="node-hint">{{ t('uiNodeScreenFrameRateHelp') }}</p>
      <div class="node-screen-controlbar">
        <strong>
          {{
            controlling && status?.active
              ? t('uiNodeScreenControllingTarget', { value1: peer.name })
              : status?.active
                ? t('uiNodeScreenRemoteTaskHasControl')
                : t('uiNodeScreenViewingTargetName', { value1: peer.name })
          }}
        </strong>
        <button :disabled="busy || !enabled || !windowId || controlling" @click="perform(acquire)">{{ t('uiNodeScreenTakeControl') }}</button>
        <button :disabled="!controlling" @click="perform(() => release())">{{ t('uiNodeScreenRelease') }}</button>
      </div>
      <p v-if="error" class="node-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="node-notice" role="status">{{ notice }}</p>
      <div v-if="status?.pausedRunId" class="node-pending">
        <p>{{ t('uiNodeScreenTaskControlPausedHelp') }}</p>
        <button
          v-if="peer.capabilities?.account.role === 'owner'"
          :disabled="busy || !enabled"
          @click="
            perform(async () => {
              await remote('computer.allowRun', { runId: status!.pausedRunId });
              await refreshStatus();
              notice = t('uiNodeScreenTaskControlAllowed');
            })
          "
        >
          {{ t('uiNodeScreenAllowTaskContinueControl') }}
        </button>
        <p v-else class="node-hint">{{ t('uiNodeScreenOwnerApprovalRequired') }}</p>
      </div>
      <p v-if="monitorId" class="node-hint">{{ t('uiNodeScreenDisplayViewHelp') }}</p>
      <div v-if="image" class="node-screen-frame">
        <div class="node-frame-metadata">
          <span>{{ image.width }}×{{ image.height }} · {{ image.dpi }} DPI · {{ image.monitorId }}</span>
          <span>
            {{ t('uiNodeScreenRequestRoundTrip') }} {{ roundTripMs }} ms · {{ Math.round((image.data.length * 0.75) / 1024) }} KB ·
            {{ new Date(receivedAt).toLocaleTimeString(shellLocale) }}
          </span>
        </div>
        <img
          :src="imageUrl"
          :class="{ controlling: canInput }"
          :style="{ touchAction: controlling ? 'none' : 'auto' }"
          tabindex="0"
          :alt="t('uiNodeScreenRemoteScreenAlt')"
          draggable="false"
          @pointerdown="pointerDown"
          @pointerup="pointerUp"
          @pointercancel="
            gesture = undefined;
            schedule();
          "
          @wheel="wheel"
          @keydown="keyboard"
          @contextmenu.prevent
        />
      </div>
      <p v-else class="node-empty">{{ t('uiNodeScreenScreenTransmissionHelp') }}</p>
      <div v-if="windowId" class="node-screen-input">
        <div class="node-row">
          <label>
            {{ t('uiNodeScreenTouchAndMouse') }}
            <select v-model="pointerMode">
              <option value="click">{{ t('uiComputerPaneClick') }}</option>
              <option value="drag">{{ t('uiComputerPaneDrag') }}</option>
              <option value="scroll">{{ t('uiComputerPaneScroll') }}</option>
            </select>
          </label>
          <button :disabled="busy || !enabled || !controlling" @click="perform(focusWindow)">{{ t('uiNodeScreenActivateWindow') }}</button>
          <button :disabled="!canInput" @click="perform(() => action({ action: 'key', key: 'Enter' }))">Enter</button>
          <button :disabled="!canInput" @click="perform(() => action({ action: 'key', key: 'Escape' }))">Esc</button>
          <button :disabled="!canInput" @click="perform(() => action({ action: 'key', key: 'Tab' }))">Tab</button>
        </div>
        <label>
          {{ t('uiComputerPaneTypeText') }}
          <textarea v-model="inputText" :aria-label="t('uiNodeScreenRemoteTextInput')" :placeholder="t('uiNodeScreenRemoteTextInputHelp')"></textarea>
        </label>
        <button
          :disabled="!canInput || !inputText"
          @click="
            perform(async () => {
              const text = inputText;
              await action({ action: 'type', text });
              if (inputText === text) inputText = '';
            })
          "
        >
          {{ t('uiNodeScreenTypeIntoRemoteFocus') }}
        </button>
        <div class="node-row">
          <input v-model="key" :aria-label="t('uiNodeScreenRemoteKeyCombination')" placeholder="Control+A" />
          <button :disabled="!canInput || !key" @click="perform(() => action({ action: 'key', key }))">{{ t('uiComputerPaneSendKeystrokes') }}</button>
        </div>
        <p class="node-hint">{{ t('uiNodeScreenRemoteInputHelp') }}</p>
      </div>
    </template>
  </div>
</template>
