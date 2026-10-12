<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, onUnmounted, ref, watch } from 'vue';
import type { RunEvent, RunRecord, RuntimeDiagnostics } from '@graycode/contracts';
import { rpc as call, subscribe } from '../api';
import { state } from '../state';
import JsonDetails from './JsonDetails.vue';
import NavigationIcon from './navigation/NavigationIcon.vue';
import { webUi } from '../webBridge';
import { eventLabels, eventLane, eventLaneLabel, type EventLane, mergeRunEvents, requestGroups, runActivity, type RequestSnapshot } from '../runInspector';

const open = ref(false);
watch(open, (value) => {
  state.inspectorOpen = value;
  if (value) {
    followLatestRequest = true;
    void loadDiagnostics();
  } else {
    previewEpoch++;
    request.value = null;
    requestLoading.value = false;
  }
});
onUnmounted(() => {
  state.inspectorOpen = false;
});
const runs = ref<RunRecord[]>([]);
const selectedId = ref('');
const events = ref<RunEvent[]>([]);
const error = ref('');
const request = ref<RequestSnapshot | null>(null);
const requestLoading = ref(false);
const diagnostics = ref<RuntimeDiagnostics | null>(null);
const view = ref<'groups' | 'plain'>('groups');
const lane = ref<EventLane | 'all'>('all');
const loading = ref(false);
const more = ref(false);
let conversationEpoch = 0;
let runEpoch = 0;
let previewEpoch = 0;
let followLatestRequest = true;
let historyCursor = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let runsRequest: Promise<void> | undefined;
let refreshRunsAgain = false;
let disposed = false;
const selected = computed(() => runs.value.find((run) => run.id === selectedId.value));
const activity = computed(() =>
  window.graycode?.kind === 'web' && webUi.connection !== 'connected'
    ? t('uiRunInspectorReconnectingTaskStatus')
    : !selected.value && state.snapshot?.settings.providers.length === 0
      ? t('uiRunInspectorModelServiceRequired')
      : runActivity(selected.value, events.value),
);
const visibleEvents = computed(() => events.value.filter((event) => lane.value === 'all' || eventLane(event.type) === lane.value));
const json = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
// 请求预览内容只随请求变化格式化，避免运行事件更新时反复序列化长上下文正文。
const groups = computed(() => requestGroups(request.value?.body).map((group) => ({ title: group.title, text: json(group.value) })));
const plainRequestBody = computed(() => JSON.stringify(request.value?.body, null, 2));
const latestRequest = computed(() => {
  for (let index = events.value.length - 1; index >= 0; index--) {
    if (events.value[index].type === 'model.request') return events.value[index];
  }
  return undefined;
});
const streaming = computed(() => {
  for (let index = events.value.length - 1; index >= 0; index--) {
    if (events.value[index].type === 'message.saved') return events.value[index].payload.streaming as { inputEvents: number; outputEvents: number } | undefined;
  }
  return undefined;
});
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString(shellLocale.value);
async function loadDiagnostics() {
  try {
    diagnostics.value = await call('diagnostics.get');
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}
function mergeEvents(incoming: RunEvent[]) {
  events.value = mergeRunEvents(events.value, incoming);
}
function loadRuns(): Promise<void> {
  if (disposed) return Promise.resolve();
  if (runsRequest) {
    refreshRunsAgain = true;
    return runsRequest;
  }
  // 任务事件可能密集到达；慢连接只排一轮补读，避免旧列表覆盖较新的选择。
  runsRequest = (async () => {
    do {
      refreshRunsAgain = false;
      await readRuns();
    } while (refreshRunsAgain && !disposed);
  })().finally(() => {
    runsRequest = undefined;
  });
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
    if (!result.some((run) => run.id === selectedId.value)) selectedId.value = result[0]?.id ?? '';
  } catch (cause) {
    if (epoch === conversationEpoch) error.value = (cause as Error).message;
  }
}
async function loadEvents() {
  const epoch = runEpoch;
  const id = selectedId.value;
  if (!id || loading.value) return;
  loading.value = true;
  try {
    const result = await call('runs.events', { id, afterSequence: historyCursor });
    if (epoch !== runEpoch) return;
    mergeEvents(result);
    historyCursor = result.at(-1)?.sequence ?? historyCursor;
    more.value = result.length === 500;
  } catch (cause) {
    if (epoch === runEpoch) error.value = (cause as Error).message;
  } finally {
    if (epoch === runEpoch) loading.value = false;
  }
}
async function showRequest(iteration: number, automatic = false) {
  if (!automatic) followLatestRequest = false;
  const epoch = ++previewEpoch;
  const id = selectedId.value;
  request.value = null;
  requestLoading.value = true;
  try {
    let result = await call('runs.request', { id, iteration });
    if (epoch !== previewEpoch) return;
    // 运行轮次在准备上下文时就会前进，此时最近已经发出的请求仍是上一轮。
    if (!result && automatic && iteration > 1) result = await call('runs.request', { id, iteration: iteration - 1 });
    if (epoch !== previewEpoch) return;
    request.value = result;
    if (!result && !automatic) error.value = t('uiRunInspectorRequestBodyNotSaved');
  } catch (cause) {
    if (epoch === previewEpoch) error.value = (cause as Error).message;
  } finally {
    if (epoch === previewEpoch) requestLoading.value = false;
  }
}
function previewLatestRequest() {
  if (!open.value || !followLatestRequest) return;
  const iteration = Math.max(selected.value?.iteration ?? 0, Number(latestRequest.value?.payload.iteration ?? 0));
  if (iteration > 0) void showRequest(iteration, true);
}
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void loadRuns();
  }, 120);
}
watch(
  () => state.conversationId,
  () => {
    conversationEpoch++;
    runs.value = [];
    selectedId.value = '';
    error.value = '';
    void loadRuns();
  },
  { immediate: true },
);
watch(selectedId, () => {
  runEpoch++;
  previewEpoch++;
  historyCursor = 0;
  events.value = [];
  request.value = null;
  requestLoading.value = false;
  followLatestRequest = true;
  loading.value = false;
  more.value = false;
  void loadEvents();
});
watch([open, selectedId, () => selected.value?.iteration, () => latestRequest.value?.sequence], previewLatestRequest);
const unsubscribe = subscribe((notification) => {
  if (notification.type === 'transport.connected') {
    void loadRuns();
    void loadEvents();
  }
  if (notification.type === 'ui.conversation.focused' && notification.resynchronized) {
    void loadRuns();
    void loadEvents();
  }
  if (notification.type !== 'event') return;
  const event = notification.event as RunEvent;
  if (event.runId === selectedId.value) mergeEvents([event]);
  if (event.type.startsWith('run.') || event.type.startsWith('approval.')) refreshSoon();
});
onUnmounted(() => {
  disposed = true;
  refreshRunsAgain = false;
  conversationEpoch++;
  runEpoch++;
  previewEpoch++;
  unsubscribe();
  clearTimeout(refreshTimer);
});
</script>
<template>
  <div class="run-status-strip">
    <span class="run-status-dot" :data-status="selected?.status"></span>
    <span>{{ activity }}</span>
    <button class="quiet-button" :aria-expanded="open" @click="open = !open">{{ t('uiRunInspectorRunHistoryAndRequests') }}</button>
  </div>
  <section v-if="open" class="run-inspector" :aria-label="t('uiRunInspectorRunHistoryAndRequests')">
    <header>
      <strong>{{ t('uiRunInspectorRunHistory') }}</strong>
      <select v-model="selectedId" :aria-label="t('uiRunInspectorSelectRun')">
        <option v-if="!runs.length" value="">{{ t('uiRunInspectorNoConversationTasks') }}</option>
        <option v-for="run in runs" :key="run.id" :value="run.id">
          {{ new Date(run.createdAt).toLocaleString(shellLocale) }} · {{ run.id.slice(0, 8) }}
        </option>
      </select>
      <button
        class="quiet-button"
        @click="
          loadRuns();
          loadEvents();
          loadDiagnostics();
        "
      >
        {{ t('uiBrowserPaneRefresh') }}
      </button>
      <button class="quiet-button" @click="open = false">{{ t('close') }}</button>
    </header>
    <p v-if="error" class="inspector-error">
      {{ error }}
      <button @click="error = ''">{{ t('uiComputerPaneCollapse') }}</button>
    </p>
    <details v-if="diagnostics" class="inspector-diagnostics">
      <summary class="inspector-disclosure">
        <NavigationIcon name="chevron" class="disclosure-chevron" />
        {{ t('uiRunInspectorDiagnostics') }}
      </summary>
      <div class="inspector-metrics" :aria-label="t('uiRunInspectorResourceDiagnosticsSnapshot')">
        <span>{{ t('uiRunInspectorActiveTasks') }} {{ diagnostics.activeRuns }}</span>
        <span>{{ t('uiRunInspectorWorkspaceCommandProcesses') }} {{ diagnostics.managedProcesses }}</span>
        <span>{{ t('uiNodeTasksTool') }} {{ diagnostics.registeredTools }}</span>
        <span>{{ t('uiRunInspectorParameterValidationCache') }} {{ diagnostics.compiledToolSchemas }}</span>
        <span v-if="diagnostics.eventStream">
          {{ t('uiRunInspectorWebPush') }} {{ diagnostics.eventStream.connections }} {{ t('uiRunInspectorPushConnectionsBacklog') }}
          {{ (diagnostics.eventStream.queuedBytes / 1024).toFixed(1) }} {{ t('uiRunInspectorPushBacklogResyncs') }} {{ diagnostics.eventStream.backlogResets }}
          {{ t('uiMemoryLibraryCalls') }}
        </span>
        <span v-if="streaming?.inputEvents">
          {{ t('uiRunInspectorLatestReplyPrefix') }}{{ streaming.inputEvents }} {{ t('uiRunInspectorMergedDeltasSuffix') }} {{ streaming.outputEvents }}
          {{ t('uiRunInspectorPushCountSuffix') }}
        </span>
      </div>
    </details>
    <div class="inspector-columns">
      <div class="run-timeline">
        <nav>
          <button
            v-for="name in ['all', 'task', 'model', 'tool', 'interaction', 'context'] as const"
            :key="name"
            :aria-pressed="lane === name"
            @click="lane = name"
          >
            {{ eventLaneLabel(name) }}
          </button>
        </nav>
        <p v-if="!events.length" class="inspector-empty">{{ loading ? t('uiRunInspectorLoadingRunHistory') : t('uiRunInspectorRunHistoryHelp') }}</p>
        <article v-for="event in visibleEvents" :key="event.sequence" class="timeline-event" :data-lane="eventLane(event.type)">
          <div>
            <time>{{ time(event.timestamp) }}</time>
            <span>{{ eventLaneLabel(eventLane(event.type)) }}</span>
            <strong>{{ eventLabels[event.type] ?? event.type }}</strong>
          </div>
          <button v-if="event.type === 'model.request'" @click="showRequest(Number(event.payload.iteration))">
            {{ t('uiRunInspectorViewRequestPrefix') }} {{ event.payload.iteration }} {{ t('uiRunInspectorViewRequestSuffix') }}
          </button>
          <JsonDetails v-if="Object.keys(event.payload).length" :label="t('uiRunInspectorDetails')" :value="event.payload" />
        </article>
        <button v-if="more" class="quiet-button" :disabled="loading" @click="loadEvents">{{ t('uiRunInspectorContinueReading') }}</button>
      </div>
      <div class="request-preview">
        <header>
          <strong>{{ t('uiRunInspectorActualRequestBody') }}</strong>
          <button :aria-pressed="view === 'groups'" @click="view = 'groups'">{{ t('uiComputerPaneGroup') }}</button>
          <button :aria-pressed="view === 'plain'" @click="view = 'plain'">{{ t('uiRunInspectorRawJSON') }}</button>
        </header>
        <p class="preview-note">{{ t('uiRunInspectorRequestBodyHelp') }}</p>
        <p v-if="requestLoading" class="inspector-empty">{{ t('uiRunInspectorLoadingRequest') }}</p>
        <p v-else-if="!request" class="inspector-empty">{{ t('uiRunInspectorNoRequestRecords') }}</p>
        <template v-else>
          <p>{{ request.model }} · {{ request.protocol }} · {{ time(request.capturedAt) }}</p>
          <p v-if="request.metrics" class="preview-note">
            {{ request.metrics.inputItems }} {{ t('uiRunInspectorInputItemsCount') }} {{ request.metrics.inputImages }}
            {{ t('uiRunInspectorInputImagesCount') }} {{ request.metrics.nativeTools }} {{ t('uiRunInspectorNativeToolDeclarationsCount') }}
          </p>
          <JsonDetails
            v-if="request.turnContext?.characterTurn"
            class="request-group"
            :label="t('uiRunInspectorTurnResourceActivation')"
            :value="request.turnContext.characterTurn"
          />
          <pre v-if="view === 'plain'">{{ plainRequestBody }}</pre>
          <template v-else>
            <details v-for="(group, index) in groups" :key="index" class="request-group" open>
              <summary class="inspector-disclosure">
                <NavigationIcon name="chevron" class="disclosure-chevron" />
                {{ group.title }}
              </summary>
              <pre>{{ group.text }}</pre>
            </details>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>
<style scoped>
.inspector-diagnostics {
  padding: 8px 16px;
  border-bottom: 1px solid var(--gc-border-subtle);
  color: var(--gc-text-muted);
}
.inspector-disclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.65;
  list-style: none;
  cursor: pointer;
}
.inspector-disclosure::-webkit-details-marker {
  display: none;
}
.disclosure-chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
details[open] > .inspector-disclosure .disclosure-chevron {
  transform: rotate(90deg);
}
.inspector-metrics {
  display: flex;
  gap: 8px 20px;
  flex-wrap: wrap;
  padding-top: 8px;
  color: var(--gc-text-muted);
  font-size: 12px;
}
.run-status-strip {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
  padding: 0 14px;
  color: var(--gc-text-muted);
  font-size: 12px;
}
.run-status-strip button {
  margin-left: auto;
  font-size: 12px;
}
.run-status-dot {
  width: 6px;
  height: 6px;
  background: var(--gc-text-muted);
}
.run-status-dot[data-status='running'] {
  background: var(--gc-accent);
}
.run-status-dot[data-status='failed'] {
  background: var(--gc-danger);
}
.run-inspector {
  position: fixed;
  inset: 76px 18px 35px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-base);
  box-shadow: var(--gc-shadow-md);
  color: var(--gc-text-primary);
}
.run-inspector header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.run-inspector header select {
  flex: 1;
  min-width: 0;
}
.inspector-columns {
  display: grid;
  grid-template-columns: minmax(250px, 38%) minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}
.run-timeline,
.request-preview {
  overflow: auto;
  min-width: 0;
  padding: 12px 16px;
}
.run-timeline {
  border-right: 1px solid var(--gc-border-subtle);
}
.run-timeline nav {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding-bottom: 16px;
}
.run-inspector button,
.run-inspector select {
  font: inherit;
  color: var(--gc-text-primary);
  background: var(--gc-surface-sunken);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  padding: 5px 9px;
  cursor: pointer;
}
.run-inspector button[aria-pressed='true'] {
  border-bottom-color: var(--gc-accent);
  color: var(--gc-accent);
}
.timeline-event {
  border-left: 2px solid var(--gc-border-subtle);
  padding: 0 0 18px 12px;
}
.timeline-event[data-lane='model'] {
  border-left-color: var(--gc-accent);
}
.timeline-event > div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.timeline-event time,
.timeline-event span {
  color: var(--gc-text-muted);
  font-size: 11px;
}
.timeline-event strong {
  font-size: 12px;
}
.timeline-event details {
  margin-top: 6px;
}
.run-inspector pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.65 var(--gc-font-code);
  margin: 10px 0;
}
.request-preview > header {
  padding: 0 0 12px;
}
.request-preview > header strong {
  margin-right: auto;
}
.preview-note,
.inspector-empty {
  color: var(--gc-text-muted);
  font-size: 12px;
  line-height: 1.7;
}
.request-group {
  margin: 14px 0;
  border: 1px solid var(--gc-border-subtle);
  padding: 12px;
}
.inspector-error {
  color: var(--gc-danger);
  margin: 8px 16px;
}
@media (max-width: 700px) {
  .run-inspector {
    inset: 88px 5px 28px;
  }
  .inspector-columns {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .run-timeline,
  .request-preview {
    overflow: visible;
  }
  .run-timeline {
    border-right: 0;
    border-bottom: 1px solid var(--gc-border-subtle);
  }
  .run-inspector > header {
    flex-wrap: wrap;
  }
}
</style>
