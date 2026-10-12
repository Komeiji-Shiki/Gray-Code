<script lang="ts">
export interface NodeTaskDraft {
  text: string;
  workspaceId: string;
  agentId: string;
  selectedRunId: string;
  request?: { fingerprint: string; key: string };
}
</script>
<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, ref, watch, onUnmounted } from 'vue';
import type { ApprovalRequest, NodePeerSummary, NodeTaskDispatch, NodeTaskDiff, PlatformMessage, QuestionRequest, RunRecord } from '@graycode/contracts';
import { call, subscribe } from '../api';
import ApprovalButtons from './ApprovalButtons.vue';
const props = defineProps<{ peer: NodePeerSummary; draft: NodeTaskDraft; visible: boolean }>();
const rows = ref<RunRecord[]>([]);
const dispatches = ref<NodeTaskDispatch[]>([]);
const result = ref<{
  run: RunRecord;
  history: { messages: PlatformMessage[] };
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  diffs: NodeTaskDiff[];
}>();
const diff = ref<{ id: string; filePath: string; originalContent: string; newContent: string }>();
const answers = ref<Record<string, string[]>>({});
const error = ref('');
const busy = ref(false);
const capabilities = computed(() => props.peer.capabilities);
const pending = computed(() => dispatches.value.filter((value) => value.state === 'pending'));
const labels = computed<Record<string, string>>(() => ({
  queued: t('uiNodeTasksWaitingToRun'),
  running: t('uiNodeTasksRunning'),
  awaiting_approval: t('uiNodeTasksAwaitingApproval'),
  awaiting_input: t('awaitingInput'),
  completed: t('uiComputerPaneCompleted'),
  failed: t('uiComputerPaneFailure'),
  cancelled: t('reviewCancelledStatus'),
  interrupted: t('uiMemoryLibraryInterrupted'),
}));
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let refreshAgain = false;
let disposed = false;
const remote = <T = any,>(method: string, params: Record<string, unknown> = {}) => call<T>('nodes.request', { peerId: props.peer.id, method, params });
async function detail(id: string) {
  if (disposed) return;
  const current = ++generation;
  props.draft.selectedRunId = id;
  const value = await remote('tasks.get', { id });
  if (current === generation) result.value = value;
}
async function showDiff(id: string) {
  if (!result.value) return;
  const content = await remote<{ filePath: string; originalContent: string; newContent: string }>('tasks.diff', { id: result.value.run.id, diffId: id });
  diff.value = { id, ...content };
}
async function refresh() {
  if (disposed) return;
  const incoming = await call<NodeTaskDispatch[]>('nodes.dispatches', { peerId: props.peer.id });
  if (disposed) return;
  dispatches.value = incoming;
  if (props.peer.state !== 'online') return;
  const runs = await remote<RunRecord[]>('tasks.list');
  if (disposed) return;
  rows.value = runs;
  if (props.draft.selectedRunId) await detail(props.draft.selectedRunId);
}
async function perform(action: () => Promise<void>) {
  if (disposed || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  } finally {
    busy.value = false;
    if (!disposed && refreshAgain && props.visible) {
      refreshAgain = false;
      void perform(refresh);
    }
  }
}
async function start() {
  const text = props.draft.text;
  const fingerprint = JSON.stringify([props.peer.id, props.draft.workspaceId, props.draft.agentId, text]);
  if (props.draft.request?.fingerprint !== fingerprint) props.draft.request = { fingerprint, key: crypto.randomUUID() };
  const run = await call<RunRecord>('nodes.tasks.start', {
    peerId: props.peer.id,
    workspaceId: props.draft.workspaceId,
    agentId: props.draft.agentId,
    text,
    requestKey: props.draft.request!.key,
  });
  if (props.draft.text === text) {
    props.draft.text = '';
    props.draft.request = undefined;
  }
  await detail(run.id);
  await refresh();
}
const textOf = (message: PlatformMessage) => message.parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join('\n');
const toolsOf = (message: PlatformMessage) =>
  message.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : part.functionResponse ? [part.functionResponse] : []));
watch(
  () => [props.visible, props.peer.state],
  () => {
    if (props.visible) void perform(refresh);
  },
  { immediate: true },
);
const off = subscribe((event) => {
  if (
    !props.visible ||
    event.type !== 'nodes.event' ||
    event.peerId !== props.peer.id ||
    !['event', 'message.persisted', 'run.created', 'tasks.changed'].includes(event.notification?.type)
  )
    return;
  if (!refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!busy.value) void perform(refresh);
      else refreshAgain = true;
    }, 250);
});
onUnmounted(() => {
  disposed = true;
  refreshAgain = false;
  off();
  clearTimeout(refreshTimer);
  generation++;
});
</script>
<template>
  <div class="node-tasks">
    <p v-if="!capabilities?.tasks" class="node-hint">{{ t('uiNodeTasksTaskPermissionRequired') }}</p>
    <form v-else class="node-task-form" @submit.prevent="perform(start)">
      <div class="node-fields">
        <label>
          {{ t('uiNodeTasksRemoteProject') }}
          <select v-model="draft.workspaceId" :aria-label="t('uiNodeTasksRemoteProject')">
            <option value="" disabled>{{ t('uiNodeTasksSelectExecutionProject') }}</option>
            <option v-for="value in capabilities.workspaces" :key="value.id" :value="value.id">{{ value.name }}</option>
          </select>
        </label>
        <label>
          {{ t('uiNodeTasksRemoteAgent') }}
          <select v-model="draft.agentId" :aria-label="t('uiNodeTasksRemoteAgent')">
            <option value="" disabled>{{ t('uiNodeTasksSelectAgent') }}</option>
            <option v-for="value in capabilities.agents" :key="value.id" :value="value.id">{{ value.name }}</option>
          </select>
        </label>
      </div>
      <p v-if="draft.workspaceId" class="node-hint">{{ capabilities.workspaces.find((value) => value.id === draft.workspaceId)?.directory }}</p>
      <label>
        {{ t('uiNodeTasksTaskContent') }}
        <textarea v-model="draft.text" :aria-label="t('uiNodeTasksRemoteTaskContent')" :placeholder="t('uiNodeTasksTaskContentPlaceholder')"></textarea>
      </label>
      <div class="node-row">
        <button type="submit" :disabled="busy || peer.state !== 'online' || !draft.workspaceId || !draft.agentId || !draft.text.trim()">
          {{ t('uiNodeTasksExecutionDevicePrefix') }} {{ peer.name }} {{ t('uiNodeTasksRun') }}
        </button>
        <button type="button" :disabled="busy" @click="perform(refresh)">{{ t('uiNodeTasksRefreshTasks') }}</button>
      </div>
    </form>
    <p v-if="error" class="node-error" role="alert">{{ error }}</p>
    <div v-for="value in pending" :key="value.id" class="node-pending">
      <strong>{{ t('uiNodeTasksDispatchResultUnconfirmed') }}</strong>
      <p>{{ value.error || t('uiNodeTasksDispatchReconnectHelp') }}</p>
      <button
        :disabled="busy || peer.state !== 'online'"
        @click="
          perform(async () => {
            const run = await call('nodes.tasks.retry', { peerId: peer.id, id: value.id });
            await detail(run.id);
            await refresh();
          })
        "
      >
        {{ t('uiNodeTasksRetryOriginalRequest') }}
      </button>
    </div>
    <div class="node-task-results">
      <div class="node-run-list">
        <button v-for="run in rows" :key="run.id" :class="{ active: draft.selectedRunId === run.id }" @click="perform(() => detail(run.id))">
          <strong>{{ labels[run.status] }}</strong>
          <span>{{ new Date(run.createdAt).toLocaleString(shellLocale) }}</span>
          <small>{{ capabilities?.workspaces.find((value) => value.id === run.workspaceId)?.name || run.workspaceId }} · {{ run.id.slice(0, 8) }}</small>
        </button>
        <p v-if="!rows.length" class="node-empty">{{ t('uiNodeTasksNoDispatchedTasks') }}</p>
      </div>
      <div v-if="result" class="node-run-detail">
        <header>
          <strong>{{ labels[result.run.status] }} · {{ peer.name }}</strong>
          <button
            v-if="['queued', 'running', 'awaiting_input', 'awaiting_approval'].includes(result.run.status)"
            :disabled="busy || peer.state !== 'online'"
            @click="
              perform(async () => {
                await remote('tasks.cancel', { id: result!.run.id });
                await refresh();
              })
            "
          >
            {{ t('uiNodeTasksStopTask') }}
          </button>
        </header>
        <p class="node-hint">
          {{ t('uiNodeTasksAccount') }} {{ capabilities?.account.displayName }} {{ t('uiNodeTasksProjectLabel') }}
          {{ capabilities?.workspaces.find((value) => value.id === result?.run.workspaceId)?.name || result.run.workspaceId }}
        </p>
        <p v-if="result.run.error" class="node-error">{{ result.run.error }}</p>
        <article v-for="message in result.history.messages" :key="message.id" class="node-message">
          <small>
            {{ message.role === 'user' ? t('uiNodeTasksRequest') : message.role === 'model' ? t('uiNodeTasksReply') : t('uiMemoryLibraryToolResult') }}
          </small>
          <div v-if="textOf(message)" class="node-message-text">{{ textOf(message) }}</div>
          <details v-for="(tool, index) in toolsOf(message)" :key="index">
            <summary>{{ t('uiNodeTasksTool') }} {{ (tool as any).name || t('uiNodeTasksActions') }}</summary>
            <pre>{{ JSON.stringify(tool, null, 2) }}</pre>
          </details>
        </article>
        <section v-for="approval in result.approvals" :key="approval.id" class="node-pending">
          <strong>{{ t('uiNodeTasksAwaitingApprovalPrefix') }}{{ approval.toolName }}</strong>
          <pre>{{ JSON.stringify(approval.args, null, 2) }}</pre>
          <p v-if="approval.reason">{{ approval.reason }}</p>
          <ApprovalButtons
            :choices="approval.choices"
            :disabled="busy"
            @resolve="
              (decision) =>
                perform(async () => {
                  await remote('tasks.approve', { id: result!.run.id, approvalId: approval.id, ...decision });
                  await refresh();
                })
            "
          />
        </section>
        <section v-for="value in result.diffs" :key="value.id" class="node-pending">
          <strong>{{ t('uiNodeTasksPendingFileChangesPrefix') }}{{ value.path }}</strong>
          <p v-if="value.warning" class="node-error">{{ value.warning }}</p>
          <button :disabled="busy" @click="perform(() => showDiff(value.id))">{{ t('uiNodeTasksViewChanges') }}</button>
          <template v-if="diff?.id === value.id">
            <label>
              {{ t('uiNodeTasksBeforeChanges') }}
              <pre>{{ diff.originalContent || t('uiNodeTasksNewFile') }}</pre>
            </label>
            <label>
              {{ t('uiNodeTasksAfterChanges') }}
              <pre>{{ diff.newContent }}</pre>
            </label>
            <div class="node-row">
              <button
                :disabled="busy"
                @click="
                  perform(async () => {
                    await remote('tasks.resolveDiff', { id: result!.run.id, diffId: value.id, accepted: true });
                    diff = undefined;
                    await refresh();
                  })
                "
              >
                {{ t('uiNodeTasksAcceptRemoteFileChanges') }}
              </button>
              <button
                :disabled="busy"
                @click="
                  perform(async () => {
                    await remote('tasks.resolveDiff', { id: result!.run.id, diffId: value.id, accepted: false });
                    diff = undefined;
                    await refresh();
                  })
                "
              >
                {{ t('uiNodeTasksRejectChanges') }}
              </button>
            </div>
          </template>
        </section>
        <section v-for="question in result.questions" :key="question.id" class="node-pending">
          <label v-for="(item, index) in question.questions" :key="index">
            {{ item.title }}
            <input
              :value="answers[question.id]?.[index] || ''"
              @input="(answers[question.id] ||= [])[index] = ($event.target as HTMLInputElement).value"
              :list="`node-answer-${question.id}-${index}`"
            />
            <datalist :id="`node-answer-${question.id}-${index}`"><option v-for="option in item.options" :key="option" :value="option" /></datalist>
          </label>
          <button
            :disabled="busy"
            @click="
              perform(async () => {
                await remote('tasks.answer', {
                  id: result!.run.id,
                  questionId: question.id,
                  answers: question.questions.map((_, i) => answers[question.id]?.[i] || ''),
                });
                await refresh();
              })
            "
          >
            {{ t('uiNodeTasksSubmitAnswer') }}
          </button>
        </section>
      </div>
    </div>
  </div>
</template>
