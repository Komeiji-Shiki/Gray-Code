<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import type { ComputerAction, ComputerCapture, ComputerDisplayCapture, ComputerObservation, ComputerStatus, ComputerWindows, NodePeerSummary } from '@graycode/contracts';
import { call, subscribe } from '../api';
const props = defineProps<{ peer: NodePeerSummary; visible: boolean }>();
const inventory = ref<ComputerWindows>(); const observation = ref<ComputerObservation>(); const displayFrame = ref<ComputerDisplayCapture>();
const target = ref(''); const filter = ref(''); const status = ref<ComputerStatus>(); const viewing = ref(false); const controlling = ref(false);
const fps = ref(1); const width = ref(1280); const format = ref<'png' | 'jpeg'>('png');
const pointerMode = ref<'click' | 'drag' | 'scroll'>('click'); const inputText = ref(''); const key = ref('Control+A');
const error = ref(''); const notice = ref(''); const busy = ref(false); const frameBusy = ref(false); const pageVisible = ref(!document.hidden);
const roundTripMs = ref(0); const receivedAt = ref(0);
const gesture = ref<{ x: number; y: number; time: number; observationId: string }>();
let timer: ReturnType<typeof setTimeout> | undefined; let epoch = 0; let disposed = false; let refreshingStatus: Promise<void> | undefined; let targetPending = false;
const windowId = computed(() => target.value.startsWith('window:') ? target.value.slice(7) : '');
const monitorId = computed(() => target.value.startsWith('display:') ? target.value.slice(8) : '');
const image = computed<ComputerCapture | ComputerDisplayCapture | undefined>(() => displayFrame.value ?? observation.value?.screenshot);
const imageUrl = computed(() => image.value ? `data:${image.value.mimeType};base64,${image.value.data}` : undefined);
const windows = computed(() => inventory.value?.windows.filter(value => !filter.value || `${value.title} ${value.executable}`.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())) ?? []);
const enabled = computed(() => props.visible && pageVisible.value && props.peer.state === 'online');
const canInput = computed(() => enabled.value && controlling.value && status.value?.active && !!observation.value && !busy.value && !frameBusy.value);
const remote = <T = any>(method: string, params: Record<string, unknown> = {}) => call<T>('nodes.request', { peerId: props.peer.id, method, params });
function clearTimer() { clearTimeout(timer); timer = undefined; }
function schedule() {
  clearTimer();
  if (!disposed && enabled.value && viewing.value && target.value && !gesture.value && !busy.value && !frameBusy.value)
    timer = setTimeout(() => { void capture().catch(failed); }, 1000 / fps.value);
}
function failed(cause: unknown) { error.value = (cause as Error).message; viewing.value = false; gesture.value = undefined; clearTimer(); }
async function readSelectedTarget() {
  if (!targetPending || disposed || !enabled.value || busy.value || frameBusy.value) return;
  targetPending = false; const selected = target.value;
  await perform(async () => { await release(); if (selected === target.value) await capture(); });
}
async function refreshStatus() {
  if (refreshingStatus) return refreshingStatus;
  refreshingStatus = (async () => { status.value = await remote('computer.status'); if (!status.value?.active) controlling.value = false; })().finally(() => { refreshingStatus = undefined; });
  return refreshingStatus;
}
async function load() {
  if (!enabled.value || !props.peer.capabilities?.computer) return;
  const value = await remote<ComputerWindows>('computer.windows'); inventory.value = value; await refreshStatus();
  if (windowId.value && !value.windows.some(item => item.id === windowId.value) || monitorId.value && !value.displays.some(item => item.id === monitorId.value)) target.value = '';
}
async function capture(full = false) {
  if (!enabled.value || !target.value || frameBusy.value || gesture.value) return;
  const current = epoch; frameBusy.value = true; clearTimer(); const started = performance.now();
  try {
    const params = { width: width.value, height: 2160, format: format.value, quality: 85 };
    if (windowId.value) {
      const result = await remote<ComputerObservation>('computer.observe', { windowId: windowId.value, screenshot: true, frameOnly: !full, ...params });
      if (current !== epoch || !enabled.value) return; observation.value = result; displayFrame.value = undefined;
    } else if (monitorId.value) {
      const result = await remote<ComputerDisplayCapture>('computer.display', { monitorId: monitorId.value, ...params });
      if (current !== epoch || !enabled.value) return; displayFrame.value = result; observation.value = undefined;
    }
    roundTripMs.value = Math.round(performance.now() - started); receivedAt.value = Date.now(); error.value = '';
  } catch (cause) { if (current === epoch && enabled.value) throw cause; }
  finally { frameBusy.value = false; if (targetPending) void readSelectedTarget(); else schedule(); }
}
async function release(stop = false) {
  controlling.value = false; gesture.value = undefined; epoch++; clearTimer();
  if (props.peer.state === 'online') await remote(stop ? 'computer.stop' : 'computer.release');
  await refreshStatus(); schedule();
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; clearTimer();
  try { await action(); } catch (cause) { failed(cause); } finally { busy.value = false; if (targetPending) void readSelectedTarget(); else schedule(); }
}
async function acquire() {
  if (!windowId.value) throw new Error('请先选择要操作的具体窗口。');
  status.value = await remote('computer.acquire', { windowIds: [windowId.value] }); controlling.value = true; await capture();
}
async function focusWindow() {
  if (!controlling.value || !windowId.value) throw new Error('请先取得所选窗口的控制权。');
  // 最小化或尚无截图的窗口，也能通过新鲜的窗口身份恢复并切换焦点。
  const current = await remote<ComputerObservation>('computer.observe', { windowId: windowId.value, frameOnly: true });
  await remote('computer.action', { action: 'focusWindow', observationId: current.id, operationId: crypto.randomUUID() });
  await refreshStatus(); await capture();
}
async function action(args: Omit<ComputerAction, 'observationId'>, capturedId?: string) {
  const current = observation.value;
  if (!controlling.value || !current || capturedId && current.id !== capturedId) throw new Error('控制状态或画面已改变，请重新观察。');
  try { await remote('computer.action', { ...args, observationId: current.id, operationId: crypto.randomUUID() }); notice.value = '操作已执行。'; }
  finally { observation.value = undefined; await refreshStatus(); await capture(); }
}
function point(event: PointerEvent | WheelEvent) {
  const current = image.value; if (!current) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = (event.clientX - rect.left) * current.width / rect.width, y = (event.clientY - rect.top) * current.height / rect.height;
  if (x < 0 || y < 0 || x >= current.width || y >= current.height) return; return { x, y };
}
function pointerDown(event: PointerEvent) {
  if (!canInput.value || event.button !== 0) return;
  const start = point(event); if (!start || !observation.value) return;
  event.preventDefault(); const element = event.currentTarget as HTMLElement; element.focus({ preventScroll: true }); element.setPointerCapture(event.pointerId);
  gesture.value = { ...start, time: performance.now(), observationId: observation.value.id }; clearTimer();
}
function pointerUp(event: PointerEvent) {
  const start = gesture.value, end = point(event); gesture.value = undefined;
  if (!start || !end || !canInput.value) { schedule(); return; }
  event.preventDefault();
  const distance = Math.hypot(start.x - end.x, start.y - end.y);
  const args: Omit<ComputerAction, 'observationId'> = pointerMode.value === 'scroll'
    ? { action: 'scroll', coordinateSpace: 'image', x: start.x, y: start.y, scrollY: Math.max(-20, Math.min(20, Math.round((start.y - end.y) / 30))) }
    : pointerMode.value === 'drag' && distance > 4 ? { action: 'drag', coordinateSpace: 'image', x: start.x, y: start.y, toX: end.x, toY: end.y, durationMs: Math.max(100, Math.min(5000, performance.now() - start.time)) }
    : { action: 'click', coordinateSpace: 'image', ...end };
  void perform(() => action(args, start.observationId));
}
function wheel(event: WheelEvent) {
  if (!canInput.value) return; const position = point(event); if (!position) return;
  event.preventDefault(); clearTimer();
  void perform(() => action({ action: 'scroll', coordinateSpace: 'image', ...position, scrollY: Math.sign(event.deltaY) * 3, scrollX: Math.sign(event.deltaX) * 3 }));
}
function keyboard(event: KeyboardEvent) {
  if (!canInput.value || event.isComposing || event.metaKey || ['Control','Shift','Alt','Meta'].includes(event.key) || event.repeat) return;
  const name = event.key.length === 1 && /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key;
  if (!/^(?:[A-Z0-9]|F\d{1,2}|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space)$/.test(name)) return;
  event.preventDefault();
  const combo = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', name].filter(Boolean).join('+');
  void perform(() => action({ action: 'key', key: combo }));
}
function visibility() { pageVisible.value = !document.hidden; }
watch(target, () => { epoch++; observation.value = undefined; displayFrame.value = undefined; targetPending = true; void readSelectedTarget(); });
watch([fps, width, format], () => { epoch++; schedule(); });
watch(viewing, schedule);
watch(enabled, value => {
  epoch++; clearTimer(); gesture.value = undefined;
  if (value) { targetPending = !!target.value; void perform(load); }
  else { targetPending = false; viewing.value = false; controlling.value = false; if (props.peer.state === 'online') void remote('computer.release').catch(() => {}); }
}, { immediate: true });
const off = subscribe(event => { if (enabled.value && event.type === 'nodes.event' && event.peerId === props.peer.id && event.notification?.type === 'computer.changed') void refreshStatus().catch(failed); });
document.addEventListener('visibilitychange', visibility);
onUnmounted(() => { disposed = true; epoch++; viewing.value = false; clearTimer(); off(); document.removeEventListener('visibilitychange', visibility); if (props.peer.state === 'online') void remote('computer.release').catch(() => {}); });
</script>
<template>
  <div class="node-screen">
    <p v-if="!peer.capabilities?.computer" class="node-empty">此设备没有可用的电脑操作权限或 Windows 操作宿主。</p>
    <template v-else>
      <div class="node-screen-controls"><label>窗口筛选<input v-model="filter" placeholder="窗口标题或程序名" aria-label="远端窗口筛选"></label><label>观看目标<select v-model="target" aria-label="远端观看目标"><option value="">选择窗口或显示器</option><optgroup label="窗口"><option v-for="value in windows" :key="value.id" :value="`window:${value.id}`">{{ value.title }} · PID {{ value.processId }}</option></optgroup><optgroup label="显示器预览"><option v-for="value in inventory?.displays" :key="value.id" :value="`display:${value.id}`">{{ value.id }} · {{ value.bounds.width }}×{{ value.bounds.height }}</option></optgroup></select></label><button :disabled="busy || !enabled" @click="perform(load)">刷新窗口</button></div>
      <div class="node-screen-controls"><label class="node-check"><input v-model="viewing" type="checkbox" :disabled="!enabled || !target" aria-label="连续观看远端画面">连续观看</label><label>帧率<select v-model.number="fps" aria-label="远端画面帧率"><option :value="1">最多每秒 1 帧</option><option :value="2">最多每秒 2 帧</option><option :value="5">最多每秒 5 帧</option></select></label><label>画面宽度<select v-model.number="width"><option :value="960">960 像素</option><option :value="1280">1280 像素</option><option :value="1920">1920 像素</option></select></label><label>图像格式<select v-model="format"><option value="png">PNG 无损</option><option value="jpeg">JPEG</option></select></label><button :disabled="busy || frameBusy || !enabled || !target" @click="perform(()=>capture())">{{ frameBusy ? '采集中…' : '采集一帧' }}</button></div>
      <div class="node-screen-controlbar"><strong>{{ controlling && status?.active ? `正在控制 ${peer.name}` : status?.active ? '远端已有任务取得控制权' : `正在查看 ${peer.name}` }}</strong><button :disabled="busy || !enabled || !windowId || controlling" @click="perform(acquire)">取得控制权</button><button :disabled="!controlling" @click="perform(()=>release())">释放</button><button class="danger" :disabled="!enabled" @click="release(true).catch(failed)">立即停止本设备操作</button></div>
      <p v-if="error" class="node-error" role="alert">{{ error }}</p><p v-if="notice" class="node-notice" role="status">{{ notice }}</p>
      <div v-if="status?.pausedRunId" class="node-pending"><p>此设备发起的任务已暂停电脑操作，需要主人允许后才能重新取得控制权。</p><button v-if="peer.capabilities?.account.role==='owner'" :disabled="busy || !enabled" @click="perform(async()=>{await remote('computer.allowRun',{runId:status!.pausedRunId});await refreshStatus();notice='已允许任务重新观察并取得控制权。'})">允许该任务继续操作</button><p v-else class="node-hint">请由执行设备的主人账号允许任务继续。</p></div>
      <p v-if="monitorId" class="node-hint">显示器画面用于查看整体环境。需要输入时，请选择具体窗口并取得控制权。</p>
      <div v-if="image" class="node-screen-frame"><div class="node-frame-metadata"><span>{{ image.width }}×{{ image.height }} · {{ image.dpi }} DPI · {{ image.monitorId }}</span><span>请求往返 {{ roundTripMs }} ms · {{ Math.round(image.data.length * 0.75 / 1024) }} KB · {{ new Date(receivedAt).toLocaleTimeString() }}</span></div><img :src="imageUrl" :class="{controlling:canInput}" :style="{touchAction: controlling ? 'none' : 'auto'}" tabindex="0" alt="所选执行设备的实时画面" draggable="false" @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="gesture=undefined;schedule()" @wheel="wheel" @keydown="keyboard" @contextmenu.prevent></div><p v-else class="node-empty">选择观看目标后采集画面。画面只传输到当前界面。</p>
      <div v-if="windowId" class="node-screen-input"><div class="node-row"><label>触摸和鼠标<select v-model="pointerMode"><option value="click">点击</option><option value="drag">拖动</option><option value="scroll">滚动</option></select></label><button :disabled="busy || !enabled || !controlling" @click="perform(focusWindow)">切换到此窗口</button><button :disabled="!canInput" @click="perform(()=>action({action:'key',key:'Enter'}))">Enter</button><button :disabled="!canInput" @click="perform(()=>action({action:'key',key:'Escape'}))">Esc</button><button :disabled="!canInput" @click="perform(()=>action({action:'key',key:'Tab'}))">Tab</button></div><label>输入文字<textarea v-model="inputText" aria-label="远端输入文字" placeholder="手机和中文输入法可在这里编辑，再发送到远端焦点。"></textarea></label><button :disabled="!canInput || !inputText" @click="perform(async()=>{const text=inputText;await action({action:'type',text});if(inputText===text)inputText=''})">输入到远端焦点</button><div class="node-row"><input v-model="key" aria-label="远端按键组合" placeholder="Control+A"><button :disabled="!canInput || !key" @click="perform(()=>action({action:'key',key}))">发送按键</button></div><p class="node-hint">键盘组合在一次操作后释放。画面发生位移或尺寸变化时，重新采集后再操作。远端用户可移动鼠标、按键或使用 Ctrl+Alt+Esc 接管。</p></div>
    </template>
  </div>
</template>
