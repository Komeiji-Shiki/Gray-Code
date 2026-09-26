<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { RunEvent, RunRecord, RuntimeDiagnostics } from '@graycode/contracts';
import { rpc as call, subscribe } from '../api';
import { state } from '../state';
import JsonDetails from './JsonDetails.vue';
import { webUi } from '../webBridge';
import { eventLabels, eventLane, mergeRunEvents, requestGroups, runActivity, type RequestSnapshot } from '../runInspector';

const open = ref(false);
watch(open, value => { state.inspectorOpen = value; if (value) void loadDiagnostics(); });
onUnmounted(() => { state.inspectorOpen = false; });
const runs = ref<RunRecord[]>([]);
const selectedId = ref('');
const events = ref<RunEvent[]>([]);
const error = ref('');
const request = ref<RequestSnapshot | null>(null);
const diagnostics = ref<RuntimeDiagnostics | null>(null);
const view = ref<'groups' | 'plain'>('groups');
const lane = ref('全部');
const loading = ref(false);
const more = ref(false);
let conversationEpoch = 0;
let runEpoch = 0;
let previewEpoch = 0;
let historyCursor = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let runsRequest: Promise<void> | undefined;
let refreshRunsAgain = false;
let disposed = false;
const selected = computed(() => runs.value.find(run => run.id === selectedId.value));
const activity = computed(() => window.graycode?.kind === 'web' && webUi.connection !== 'connected'
  ? '正在重新连接，任务状态待同步' : !selected.value && state.snapshot?.settings.providers.length === 0
    ? '请先配置模型服务' : runActivity(selected.value, events.value));
const visibleEvents = computed(() => events.value.filter(event => lane.value === '全部' || eventLane(event.type) === lane.value));
const groups = computed(() => requestGroups(request.value?.body));
const requests = computed(() => events.value.filter(event => event.type === 'model.request'));
const streaming = computed(() => {
  for (let index = events.value.length - 1; index >= 0; index--) {
    if (events.value[index].type === 'message.saved') return events.value[index].payload.streaming as
      { inputEvents: number; outputEvents: number } | undefined;
  }
  return undefined;
});
const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString();
async function loadDiagnostics() {
  try { diagnostics.value = await call('diagnostics.get'); }
  catch (cause) { error.value = (cause as Error).message; }
}
function mergeEvents(incoming: RunEvent[]) {
  events.value = mergeRunEvents(events.value, incoming);
}
function loadRuns(): Promise<void> {
  if (disposed) return Promise.resolve();
  if (runsRequest) { refreshRunsAgain = true; return runsRequest; }
  // 任务事件可能密集到达；慢连接只排一轮补读，避免旧列表覆盖较新的选择。
  runsRequest = (async () => {
    do { refreshRunsAgain = false; await readRuns(); }
    while (refreshRunsAgain && !disposed);
  })().finally(() => { runsRequest = undefined; });
  return runsRequest;
}
async function readRuns() {
  const epoch = conversationEpoch;
  const conversationId = state.conversationId;
  if (!conversationId) return;
  try {
    const result = await call('runs.list', { conversationId });
    if (epoch !== conversationEpoch) return;
    const followLatest = !selectedId.value || selectedId.value === runs.value[0]?.id;
    runs.value = result;
    if (followLatest) selectedId.value = result[0]?.id ?? '';
    if (!result.some(run => run.id === selectedId.value)) selectedId.value = result[0]?.id ?? '';
  } catch (cause) { if (epoch === conversationEpoch) error.value = (cause as Error).message; }
}
async function loadEvents() {
  const epoch = runEpoch;
  const id = selectedId.value;
  if (!id || loading.value) return;
  loading.value = true;
  try {
    const result = await call('runs.events', { id, afterSequence: historyCursor });
    if (epoch !== runEpoch) return;
    mergeEvents(result); historyCursor = result.at(-1)?.sequence ?? historyCursor; more.value = result.length === 500;
  } catch (cause) { if (epoch === runEpoch) error.value = (cause as Error).message; }
  finally { if (epoch === runEpoch) loading.value = false; }
}
async function showRequest(iteration: number) {
  const epoch = ++previewEpoch;
  request.value = null;
  try {
    const result = await call('runs.request', { id: selectedId.value, iteration });
    if (epoch !== previewEpoch) return;
    request.value = result;
    if (!result) error.value = '这一轮没有保存请求正文。';
  } catch (cause) { if (epoch === previewEpoch) error.value = (cause as Error).message; }
}
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void loadRuns(); }, 120);
}
watch(() => state.conversationId, () => {
  conversationEpoch++; runs.value = []; selectedId.value = ''; error.value = '';
  void loadRuns();
}, { immediate: true });
watch(selectedId, () => {
  runEpoch++; previewEpoch++; historyCursor = 0; events.value = []; request.value = null; loading.value = false; more.value = false;
  void loadEvents();
});
const unsubscribe = subscribe(notification => {
  if (notification.type === 'transport.connected') { void loadRuns(); void loadEvents(); }
  if (notification.type === 'ui.conversation.focused' && notification.resynchronized) { void loadRuns(); void loadEvents(); }
  if (notification.type !== 'event') return;
  const event = notification.event as RunEvent;
  if (event.runId === selectedId.value) mergeEvents([event]);
  if (event.type.startsWith('run.') || event.type.startsWith('approval.')) refreshSoon();
});
onUnmounted(() => { disposed = true; refreshRunsAgain = false; conversationEpoch++; runEpoch++; previewEpoch++; unsubscribe(); clearTimeout(refreshTimer); });
</script>
<template>
  <div class="run-status-strip"><span class="run-status-dot" :data-status="selected?.status"></span><span>{{ activity }}</span>
    <button class="quiet-button" :aria-expanded="open" @click="open = !open">运行记录与请求预览</button>
  </div>
  <section v-if="open" class="run-inspector" aria-label="运行记录与请求预览">
    <header><strong>运行记录</strong><select v-model="selectedId" aria-label="选择运行任务"><option v-if="!runs.length" value="">当前对话暂无任务</option><option v-for="run in runs" :key="run.id" :value="run.id">{{ new Date(run.createdAt).toLocaleString() }} · {{ run.id.slice(0, 8) }}</option></select>
      <button class="quiet-button" @click="loadRuns(); loadEvents(); loadDiagnostics()">刷新</button><button class="quiet-button" @click="open = false">关闭</button></header>
    <p v-if="error" class="inspector-error">{{ error }} <button @click="error = ''">收起</button></p>
    <div v-if="diagnostics" class="inspector-metrics" aria-label="资源诊断快照">
      <span>活动任务 {{ diagnostics.activeRuns }}</span><span>工作区命令进程 {{ diagnostics.managedProcesses }}</span>
      <span>工具 {{ diagnostics.registeredTools }}</span><span>参数校验缓存 {{ diagnostics.compiledToolSchemas }}</span>
      <span v-if="diagnostics.eventStream">网页推送 {{ diagnostics.eventStream.connections }} 个连接 · 积压 {{ (diagnostics.eventStream.queuedBytes / 1024).toFixed(1) }} KiB · 重建同步 {{ diagnostics.eventStream.backlogResets }} 次</span>
      <span v-if="streaming?.inputEvents">最近回复：{{ streaming.inputEvents }} 次增量合并为 {{ streaming.outputEvents }} 次推送</span>
    </div>
    <div class="inspector-columns">
      <div class="run-timeline"><nav><button v-for="name in ['全部', '任务', '模型', '工具', '交互', '上下文']" :key="name" :aria-pressed="lane === name" @click="lane = name">{{ name }}</button></nav>
        <p v-if="!events.length" class="inspector-empty">{{ loading ? '正在读取运行记录…' : '发送消息后，可在这里查看各阶段的执行记录。' }}</p>
        <article v-for="event in visibleEvents" :key="event.sequence" class="timeline-event" :data-lane="eventLane(event.type)">
          <div><time>{{ time(event.timestamp) }}</time><span>{{ eventLane(event.type) }}</span><strong>{{ eventLabels[event.type] ?? event.type }}</strong></div>
          <button v-if="event.type === 'model.request'" @click="showRequest(Number(event.payload.iteration))">查看第 {{ event.payload.iteration }} 次请求</button>
          <JsonDetails v-if="Object.keys(event.payload).length" label="详情" :value="event.payload" />
        </article>
        <button v-if="more" class="quiet-button" :disabled="loading" @click="loadEvents">继续读取</button>
      </div>
      <div class="request-preview"><header><strong>实际请求正文</strong><button :aria-pressed="view === 'groups'" @click="view = 'groups'">分组</button><button :aria-pressed="view === 'plain'" @click="view = 'plain'">原始 JSON</button></header>
        <p class="preview-note">在发送前记录供应方格式化后的正文，包含当前消息与工具声明；请求是否成功以时间线结果为准。认证请求头不在此展示。</p>
        <p v-if="!request" class="inspector-empty">{{ requests.length ? '从时间线选择一次模型请求。' : '这次任务尚无请求记录；旧任务不会补造请求正文。' }}</p>
        <template v-else><p>{{ request.model }} · {{ request.protocol }} · {{ time(request.capturedAt) }}</p>
          <p v-if="request.metrics" class="preview-note">{{ request.metrics.inputItems }} 条输入项 · {{ request.metrics.inputImages }} 张输入图片 · {{ request.metrics.nativeTools }} 项原生工具声明</p>
          <JsonDetails v-if="request.turnContext?.characterTurn" class="request-group" label="本回合角色资料与世界书激活结果" :value="request.turnContext.characterTurn" />
          <pre v-if="view === 'plain'">{{ JSON.stringify(request.body, null, 2) }}</pre>
          <template v-else><details v-for="(group, index) in groups" :key="index" class="request-group" open><summary>{{ group.title }}</summary><pre>{{ json(group.value) }}</pre></details></template>
        </template>
      </div>
    </div>
  </section>
</template>
<style scoped>
.inspector-metrics{display:flex;gap:8px 20px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px}
.run-status-strip{display:flex;align-items:center;gap:9px;min-height:30px;padding:0 14px;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px}.run-status-strip button{margin-left:auto;font-size:12px}.run-status-dot{width:6px;height:6px;background:var(--muted)}.run-status-dot[data-status="running"]{background:var(--accent)}.run-status-dot[data-status="failed"]{background:#df7474}.run-inspector{position:fixed;inset:76px 18px 35px;z-index:50;display:flex;flex-direction:column;border:1px solid var(--border);background:var(--background,#15171b);box-shadow:0 16px 60px #0008;color:var(--text)}.run-inspector header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)}.run-inspector header select{flex:1;min-width:0}.inspector-columns{display:grid;grid-template-columns:minmax(250px,38%) minmax(0,1fr);min-height:0;flex:1}.run-timeline,.request-preview{overflow:auto;min-width:0;padding:12px 16px}.run-timeline{border-right:1px solid var(--border)}.run-timeline nav{display:flex;gap:4px;flex-wrap:wrap;padding-bottom:16px}.run-inspector button,.run-inspector select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:0;padding:5px 9px;cursor:pointer}.run-inspector button[aria-pressed="true"]{border-bottom-color:var(--accent);color:var(--accent)}.timeline-event{border-left:2px solid var(--border);padding:0 0 18px 12px}.timeline-event[data-lane="模型"]{border-left-color:var(--accent)}.timeline-event>div{display:flex;gap:8px;flex-wrap:wrap}.timeline-event time,.timeline-event span{color:var(--muted);font-size:11px}.timeline-event strong{font-size:12px}.timeline-event details{margin-top:6px}.run-inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 var(--code-font,monospace);margin:10px 0}.request-preview>header{padding:0 0 12px}.request-preview>header strong{margin-right:auto}.preview-note,.inspector-empty{color:var(--muted);font-size:12px;line-height:1.7}.request-group{margin:14px 0;border:1px solid var(--border);padding:12px}.request-group summary,.timeline-event summary{cursor:pointer}.inspector-error{color:#df7474;margin:8px 16px}@media(max-width:700px){.run-inspector{inset:88px 5px 28px}.inspector-columns{grid-template-columns:1fr;overflow:auto}.run-timeline,.request-preview{overflow:visible}.run-timeline{border-right:0;border-bottom:1px solid var(--border)}.run-inspector>header{flex-wrap:wrap}}
</style>
