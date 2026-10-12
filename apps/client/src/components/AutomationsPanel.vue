<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { AutomationCreate, AutomationOptions, AutomationSchedule, AutomationView } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { state } from '../state';
import AutomationEventFields from './AutomationEventFields.vue';
import { eventForm, eventConfiguration } from './automationEventForm';
import { reasoningLevelsForModel } from '../../../../shared/reasoningEffort';
import { shellText as t, shellLocale } from '../i18n';

const props = defineProps<{ open: boolean; companionRequest?: { conversationId: string } }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const rows = ref<AutomationView[]>([]);
const options = ref<AutomationOptions>();
const selectedId = ref('');
const creating = ref(false);
const editingId = ref('');
const busy = ref(false);
const error = ref('');
const filter = ref<'all' | AutomationCreate['kind']>('all');
const confirmRemove = ref(false);
let refreshEpoch = 0;
let formEpoch = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const form = reactive({
  kind: 'goal' as AutomationCreate['kind'],
  name: '',
  objective: '',
  target: 'new',
  agentId: '',
  providerId: '',
  modelId: '',
  promptModeId: '',
  reasoningEffort: '',
  workspaceId: '',
  cadence: 'once',
  at: '',
  everyMinutes: '',
  time: '',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  weekDays: [] as number[],
  missedRunPolicy: '',
  event: eventForm(),
});
const selected = computed(() => rows.value.find((row) => row.id === selectedId.value));
const visibleRows = computed(() => rows.value.filter((row) => filter.value === 'all' || row.kind === filter.value));
const profile = computed(() => options.value?.providers.find((provider) => provider.id === form.providerId));
const modelChoices = computed(() => [...new Set([profile.value?.model, ...(profile.value?.models.map((model) => model.id) ?? [])].filter(Boolean))]);
const reasoningLevels = computed(() => (profile.value ? reasoningLevelsForModel(profile.value, form.modelId) : []));
const currentOccupied = computed(() => rows.value.some((row) => row.conversationId === options.value?.current.conversationId && row.status !== 'completed'));
const weekDays = computed(() => [
  { id: 1, name: t('uiAutomationsPanelMonday') },
  { id: 2, name: t('uiAutomationsPanelTuesday') },
  { id: 3, name: t('uiAutomationsPanelWednesday') },
  { id: 4, name: t('uiAutomationsPanelThursday') },
  { id: 5, name: t('uiAutomationsPanelFriday') },
  { id: 6, name: t('uiAutomationsPanelSaturday') },
  { id: 0, name: t('uiAutomationsPanelSunday') },
]);
const when = (value?: number) => (value ? new Date(value).toLocaleString(shellLocale.value) : '—');
const used = (row: AutomationView) => row.usage.inputTokens + row.usage.outputTokens;
const runActive = (row: AutomationView) => ['queued', 'running', 'awaiting_input', 'awaiting_approval'].includes(row.runStatus ?? '');
function status(row: AutomationView) {
  if (row.runStatus === 'awaiting_input') return t('awaitingInput');
  if (row.runStatus === 'awaiting_approval') return t('awaitingApproval');
  if (runActive(row)) return row.status === 'paused' ? t('uiAutomationsPanelPauseAfterRun') : t('uiNodeTasksRunning');
  if (row.status === 'completed') return t('uiComputerPaneCompleted');
  if (row.status === 'paused')
    return {
      restart: t('uiAutomationsPanelAwaitingRestartContinuation'),
      error: t('uiAutomationsPanelErrorOccurred'),
      input: t('uiAutomationsPanelMoreInformationNeeded'),
      user: t('uiDebugPanelPaused'),
    }[row.pauseReason ?? 'user'];
  return row.awaitingBackground
    ? t('uiAutomationsPanelWaitingForSubtaskResults')
    : row.schedule?.type === 'idle'
      ? t('uiAutomationsPanelWaitingForIdleTrigger')
      : row.kind === 'goal'
        ? t('uiAutomationsPanelReadyToContinue')
        : t('uiAutomationsPanelWaitingForTrigger');
}
async function refresh() {
  const epoch = ++refreshEpoch;
  try {
    const result = await call<AutomationView[]>('automations.list');
    if (epoch !== refreshEpoch) return;
    rows.value = result;
    if (!selectedId.value || !result.some((row) => row.id === selectedId.value)) select(result[0]);
  } catch (cause) {
    if (epoch === refreshEpoch) error.value = (cause as Error).message;
  }
}
function select(row?: AutomationView) {
  selectedId.value = row?.id ?? '';
  confirmRemove.value = false;
}
async function newTask(targetConversationId?: string) {
  if (editingId.value) {
    form.objective = '';
    form.name = '';
  }
  editingId.value = '';
  const epoch = ++formEpoch;
  const conversationId = targetConversationId ?? (form.objective && options.value ? options.value.current.conversationId : state.conversationId || undefined);
  error.value = '';
  const loaded = await call<AutomationOptions>('automations.options', { conversationId });
  if (epoch !== formEpoch || !props.open) return;
  options.value = loaded;
  const current = options.value.current;
  if (!form.objective)
    Object.assign(form, {
      target: current.conversationId && !currentOccupied.value ? 'current' : 'new',
      agentId: current.agentId,
      providerId: current.providerId,
      modelId: current.modelId,
      promptModeId: current.promptModeId,
      reasoningEffort: current.reasoningEffort ?? '',
      workspaceId: options.value.workspaces.some((workspace) => workspace.id === current.workspaceId) ? current.workspaceId : '',
    });
  creating.value = true;
}
async function editTask(row: AutomationView) {
  const epoch = ++formEpoch;
  const loaded = await call<AutomationOptions>('automations.options', { conversationId: row.conversationId });
  if (epoch !== formEpoch || !props.open) return;
  options.value = loaded;
  editingId.value = row.id;
  const source = row.schedule;
  const at = source?.type === 'once' ? source.at : source?.type === 'interval' ? source.startAt : undefined;
  const localTime = at ? new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  Object.assign(form, {
    kind: row.kind,
    name: row.name,
    objective: row.objective,
    target: 'current',
    agentId: row.agentId,
    providerId: row.configuration.providerId,
    modelId: row.configuration.modelOverride ?? '',
    promptModeId: row.configuration.promptModeId ?? '',
    reasoningEffort: row.configuration.reasoningEffort ?? '',
    cadence: source?.type === 'daily' && source.weekDays ? 'weekly' : (source?.type ?? 'once'),
    at: localTime,
    everyMinutes: source?.type === 'interval' || source?.type === 'idle' ? String(source.everyMinutes) : '',
    time: source?.type === 'daily' ? source.time : '',
    timeZone: source?.type === 'daily' ? source.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekDays: source?.type === 'daily' ? [...(source.weekDays ?? [])] : [],
    missedRunPolicy: row.missedRunPolicy ?? '',
    event: eventForm(row.event),
  });
  creating.value = true;
}
async function opened() {
  await nextTick();
  if (!props.open) return;
  if (!dialog.value?.open) dialog.value?.showModal();
  await refresh();
  if (props.companionRequest) {
    form.objective = '';
    form.name = '';
    editingId.value = '';
    await newTask(props.companionRequest.conversationId);
    if (currentOccupied.value) {
      creating.value = false;
      select(rows.value.find((row) => row.conversationId === props.companionRequest?.conversationId && row.status !== 'completed'));
      error.value = t('companionGreetingOccupied');
      return;
    }
    Object.assign(form, {
      kind: 'schedule',
      target: 'current',
      cadence: 'daily',
      time: '',
      missedRunPolicy: '',
      name: t('companionGreetingTaskName'),
      objective: t('companionGreetingObjective'),
    });
    return;
  }
  if (rows.value.length && !creating.value) {
    try {
      options.value = await call<AutomationOptions>('automations.options');
    } catch (cause) {
      error.value = (cause as Error).message;
    }
  }
  if (!rows.value.length && !creating.value) {
    try {
      await newTask();
    } catch (cause) {
      error.value = (cause as Error).message;
    }
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) void opened();
    else {
      refreshEpoch++;
      formEpoch++;
      dialog.value?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  },
);
onMounted(() => {
  if (props.open) void opened();
});
const unsubscribe = subscribe((event) => {
  if (!props.open || event.type !== 'automation.changed' || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 120);
});
onUnmounted(() => {
  refreshEpoch++;
  formEpoch++;
  unsubscribe();
  if (refreshTimer) clearTimeout(refreshTimer);
});
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await operation();
    await refresh();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function schedule(): AutomationSchedule | undefined {
  if (form.kind !== 'schedule') return;
  if (form.cadence === 'once') return { type: 'once', at: new Date(form.at).getTime() };
  if (form.cadence === 'interval') return { type: 'interval', startAt: new Date(form.at).getTime(), everyMinutes: Number(form.everyMinutes) };
  if (form.cadence === 'idle') return { type: 'idle', everyMinutes: Number(form.everyMinutes) };
  return { type: 'daily', time: form.time, timeZone: form.timeZone, ...(form.cadence === 'weekly' ? { weekDays: [...form.weekDays] } : {}) };
}
async function create() {
  const created = await call<AutomationView>(editingId.value ? 'automations.update' : 'automations.create', {
    ...(editingId.value ? { id: editingId.value } : {}),
    kind: form.kind,
    name: form.name,
    objective: form.objective,
    agentId: form.agentId,
    providerId: form.providerId,
    modelOverride: form.modelId,
    promptModeId: form.promptModeId || undefined,
    reasoningEffort: form.reasoningEffort || undefined,
    conversationId: form.target === 'current' ? options.value?.current.conversationId : undefined,
    workspaceId: form.target === 'new' ? form.workspaceId || undefined : undefined,
    event: form.kind === 'event' ? eventConfiguration(form.event) : undefined,
    schedule: schedule(),
    missedRunPolicy: form.kind === 'schedule' && form.cadence !== 'idle' ? form.missedRunPolicy : undefined,
  });
  creating.value = false;
  editingId.value = '';
  form.objective = '';
  form.name = '';
  select(created);
}
async function openConversation(id: string) {
  await call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } });
  emit('close');
}
const eventStatus = computed(() => ({
  pending: t('uiNodeTasksWaitingToRun'),
  running: t('uiNodeTasksRunning'),
  completed: t('uiComputerPaneCompleted'),
  failed: t('uiComputerPaneFailure'),
  interrupted: t('uiAutomationsPanelInterrupted'),
  cancelled: t('reviewCancelledStatus'),
  skipped: t('uiAutomationsPanelSkipped'),
}));
function eventSource(row: AutomationView) {
  const trigger = row.event?.trigger;
  return trigger?.type === 'file_changed'
    ? t('uiAutomationsPanelFileChangedEvent', { value1: trigger.path })
    : trigger?.type === 'node_online'
      ? t('uiAutomationsPanelDeviceOnlineEvent', { value1: options.value?.eventPeers?.find((item) => item.id === trigger.peerId)?.name ?? trigger.peerId })
      : trigger?.type === 'run_completed'
        ? t('uiAutomationsPanelTaskCompletedEvent', {
            value1: options.value?.eventConversations?.find((item) => item.id === trigger.conversationId)?.title ?? trigger.conversationId,
          })
        : '';
}
function providerChanged() {
  form.modelId = profile.value?.model ?? '';
  form.reasoningEffort = '';
}
</script>

<template>
  <dialog ref="dialog" class="automations-dialog" aria-labelledby="automations-title" @cancel.prevent="emit('close')">
    <header class="automations-header">
      <div>
        <h2 id="automations-title">{{ t('uiConversationSidebarAutomations') }}</h2>
        <p>{{ t('uiAutomationsPanelAutomationsHelp') }}</p>
      </div>
      <button :aria-label="t('uiAutomationsPanelCloseAutomations')" @click="emit('close')">{{ t('close') }}</button>
    </header>
    <div v-if="error" class="automations-error" role="alert">{{ error }}</div>
    <div class="automations-layout">
      <aside class="automations-list">
        <button class="primary new-automation" :disabled="busy" @click="action(newTask)">{{ t('uiAutomationsPanelNewAutomation') }}</button>
        <select v-model="filter" :aria-label="t('uiAutomationsPanelFilterAutomations')">
          <option value="all">{{ t('uiAutomationsPanelAllTasks') }}</option>
          <option value="goal">{{ t('uiAutomationsPanelLongTermGoals') }}</option>
          <option value="schedule">{{ t('uiAutomationsPanelScheduledTasks') }}</option>
          <option value="event">{{ t('uiAutomationsPanelEventTasks') }}</option>
        </select>
        <button
          v-for="row in visibleRows"
          :key="row.id"
          class="automation-row"
          :class="{ selected: row.id === selectedId && !creating }"
          @click="
            select(row);
            creating = false;
          "
        >
          <span>
            {{ row.kind === 'goal' ? t('uiAutomationsPanelGoal') : row.kind === 'event' ? t('uiMemoryGraphEvent') : t('uiAutomationsPanelSchedule') }} ·
            {{ status(row) }}
          </span>
          <strong>{{ row.name }}</strong>
          <small>{{ used(row).toLocaleString(shellLocale) }} Token · {{ row.completedRuns }} {{ t('uiAutomationsPanelRounds') }}</small>
        </button>
        <p v-if="!visibleRows.length" class="muted empty-automations">
          {{ t('uiAutomationsPanelNoneYet')
          }}{{
            filter === 'goal'
              ? t('uiAutomationsPanelLongTermGoals')
              : filter === 'schedule'
                ? t('uiAutomationsPanelScheduledTasks')
                : filter === 'event'
                  ? t('uiAutomationsPanelEventTasks')
                  : t('uiConversationSidebarAutomations')
          }}。
        </p>
      </aside>
      <main class="automation-detail">
        <form v-if="creating && options" class="automation-form" @submit.prevent="action(create)">
          <h3>{{ editingId ? t('uiAutomationsPanelEditAutomation') : t('uiAutomationsPanelNewAutomation') }}</h3>
          <label>
            {{ t('uiAutomationsPanelExecutionMode') }}
            <select v-model="form.kind" :disabled="!!editingId" :aria-label="t('uiAutomationsPanelAutomationExecutionMode')">
              <option value="goal">{{ t('uiAutomationsPanelLongTermGoalOption') }}</option>
              <option value="schedule">{{ t('uiAutomationsPanelScheduledTaskOption') }}</option>
              <option value="event">{{ t('uiAutomationsPanelEventTaskOption') }}</option>
            </select>
          </label>
          <label>
            {{ t('uiAutomationsPanelName') }}
            <input v-model="form.name" :placeholder="t('uiAutomationsPanelTitlePlaceholder')" />
          </label>
          <label>
            {{ form.kind === 'goal' ? t('uiAutomationsPanelLongTermGoals') : t('uiAutomationsPanelTaskForEachRun') }}
            <textarea
              v-model="form.objective"
              rows="5"
              required
              :placeholder="t('uiAutomationsPanelGoalPlaceholder')"
              :aria-label="t('uiAutomationsPanelAutomationGoal')"
            ></textarea>
          </label>
          <div class="automation-fields">
            <label>
              {{ t('uiAutomationsPanelLinkedConversation') }}
              <select v-model="form.target" :disabled="!!editingId">
                <option value="current" :disabled="!options.current.conversationId || (currentOccupied && !editingId)">
                  {{ t('uiAutomationsPanelCurrentConversation') }}{{ currentOccupied && !editingId ? t('uiAutomationsPanelUnfinishedAutomationSuffix') : '' }}
                </option>
                <option value="new">{{ t('uiAutomationsPanelCreateNewConversation') }}</option>
              </select>
            </label>
            <label v-if="form.target === 'new'">
              {{ t('workspace') }}
              <select v-model="form.workspaceId">
                <option value="">{{ t('uiAutomationsPanelCreateConversationDirectory') }}</option>
                <option v-for="workspace in options.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option>
              </select>
            </label>
          </div>
          <div class="automation-fields">
            <label>
              {{ t('uiAutomationsPanelAgent') }}
              <select v-model="form.agentId" required>
                <option v-for="agent in options.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
              </select>
            </label>
            <label>
              {{ t('uiAutomationsPanelPreset') }}
              <select v-model="form.promptModeId">
                <option value="">{{ t('uiAutomationsPanelInheritPreset') }}</option>
                <option v-for="mode in options.promptModes" :key="mode.id" :value="mode.id">{{ mode.name }}</option>
              </select>
            </label>
          </div>
          <div class="automation-fields">
            <label>
              {{ t('uiAutomationsPanelModelChannel') }}
              <select v-model="form.providerId" required @change="providerChanged">
                <option value="" disabled>{{ t('uiAutomationsPanelSelectChannel') }}</option>
                <option v-for="provider in options.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <label>
              {{ t('uiRunInspectorModel') }}
              <input v-model="form.modelId" list="automation-models" required :placeholder="t('uiAutomationsPanelModelIdPlaceholder')" />
              <datalist id="automation-models"><option v-for="model in modelChoices" :key="model" :value="model"></option></datalist>
            </label>
          </div>
          <label v-if="reasoningLevels.length">
            {{ t('uiAutomationsPanelReasoningEffort') }}
            <select v-model="form.reasoningEffort">
              <option value="">{{ t('uiAutomationsPanelInheritChannelSettings') }}</option>
              <option v-for="level in reasoningLevels" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
          <template v-if="form.kind === 'schedule'">
            <h4>{{ t('uiAutomationsPanelTriggerTime') }}</h4>
            <label>
              {{ t('uiAutomationsPanelRepeat') }}
              <select v-model="form.cadence" :aria-label="t('uiAutomationsPanelAutomationRepeatMode')">
                <option value="once">{{ t('uiAutomationsPanelRunOnce') }}</option>
                <option value="interval">{{ t('uiAutomationsPanelMinuteIntervals') }}</option>
                <option value="idle">{{ t('uiAutomationsPanelRepeatAfterIdle') }}</option>
                <option value="daily">{{ t('uiAutomationsPanelEveryDay') }}</option>
                <option value="weekly">{{ t('uiAutomationsPanelSelectedWeekdays') }}</option>
              </select>
            </label>
            <label v-if="form.cadence === 'once' || form.cadence === 'interval'">
              {{ form.cadence === 'once' ? t('uiAutomationsPanelRunTime') : t('uiAutomationsPanelFirstRunTime') }}{{ t('uiAutomationsPanelDeviceTimeSuffix') }}
              <input v-model="form.at" type="datetime-local" required />
            </label>
            <label v-if="form.cadence === 'interval' || form.cadence === 'idle'">
              {{ form.cadence === 'idle' ? t('uiAutomationsPanelIdleMinutes') : t('uiAutomationsPanelIntervalMinutes') }}
              <input v-model="form.everyMinutes" type="number" min="1" step="1" required :aria-label="t('uiAutomationsPanelAutomationIntervalMinutes')" />
              <small class="settings-help">
                {{ form.cadence === 'idle' ? t('uiAutomationsPanelIdleIntervalHelp') : t('uiAutomationsPanelIntervalMinutesHelp') }}
              </small>
            </label>
            <div v-if="form.cadence === 'daily' || form.cadence === 'weekly'" class="automation-fields">
              <label>
                {{ t('uiAutomationsPanelDailyTime') }}
                <input v-model="form.time" type="time" required />
              </label>
              <label>
                {{ t('uiAutomationsPanelTimeZone') }}
                <input v-model="form.timeZone" required placeholder="Asia/Shanghai" />
              </label>
            </div>
            <fieldset v-if="form.cadence === 'weekly'" class="weekday-options">
              <legend>{{ t('uiAutomationsPanelRunWeekdays') }}</legend>
              <label v-for="day in weekDays" :key="day.id">
                <input v-model="form.weekDays" type="checkbox" :value="day.id" />
                {{ t('uiAutomationsPanelWeekdayPrefix') }}{{ day.name }}
              </label>
            </fieldset>
            <label v-if="form.cadence !== 'idle'">
              {{ t('uiAutomationsPanelMissedRuns') }}
              <select v-model="form.missedRunPolicy" required>
                <option value="" disabled>{{ t('uiAutomationEventFieldsSelectBusyPolicy') }}</option>
                <option value="skip">{{ t('uiAutomationsPanelSkipMissedRuns') }}</option>
                <option value="once">{{ t('uiAutomationsPanelCatchUpOnce') }}</option>
              </select>
            </label>
          </template>
          <AutomationEventFields v-else-if="form.kind === 'event'" v-model="form.event" :options="options" />
          <p v-else class="muted">{{ t('uiAutomationsPanelGoalRestartHelp') }}</p>
          <footer class="automation-actions">
            <button type="button" @click="creating = false">{{ t('uiAutomationsPanelBackToList') }}</button>
            <button class="primary" :disabled="busy" type="submit">
              {{
                editingId
                  ? t('uiAutomationsPanelSaveKeepPaused')
                  : form.kind === 'goal'
                    ? t('uiAutomationsPanelCreateAndStart')
                    : form.kind === 'event'
                      ? t('uiAutomationsPanelCreateAndListen')
                      : t('uiAutomationsPanelCreateScheduledTask')
              }}
            </button>
          </footer>
        </form>
        <section v-else-if="selected" class="automation-summary">
          <div class="automation-title">
            <h3>{{ selected.name }}</h3>
            <span :class="['automation-status', selected.status]">{{ status(selected) }}</span>
          </div>
          <p class="automation-objective">{{ selected.objective }}</p>
          <div class="automation-statistics">
            <div>
              <small>{{ t('uiAutomationsPanelTotalTokens') }}</small>
              <strong>{{ used(selected).toLocaleString(shellLocale) }}</strong>
            </div>
            <div>
              <small>{{ t('uiAutomationsPanelCompletedRuns') }}</small>
              <strong>{{ selected.completedRuns }}</strong>
            </div>
            <div>
              <small>{{ t('uiAutomationsPanelModelCalls') }}</small>
              <strong>{{ selected.usage.requests }}</strong>
            </div>
          </div>
          <p class="muted">
            {{ t('uiMemoryLibraryType') }} {{ selected.usage.inputTokens.toLocaleString(shellLocale) }} {{ t('uiAutomationsPanelOutputLabel') }}
            {{ selected.usage.outputTokens.toLocaleString(shellLocale) }} {{ t('uiAutomationsPanelCacheHitsLabel') }}
            {{ selected.usage.cachedInputTokens.toLocaleString(shellLocale) }}{{ t('uiAutomationsPanelIncludedInInput') }}
          </p>
          <p v-if="selected.usage.estimatedRequests" class="muted">
            {{ t('uiAutomationsPanelOfWhichPrefix') }} {{ selected.usage.estimatedRequests }} {{ t('uiAutomationsPanelLocalEstimateCallsSuffix') }}
            <span v-if="selected.usage.unknownRequests">，{{ selected.usage.unknownRequests }} {{ t('uiAutomationsPanelUnconfirmedFailedUsageSuffix') }}</span>
            。
          </p>
          <p v-if="selected.schedule?.type === 'idle'" class="muted">
            {{ t('uiAutomationsPanelIdleDurationPrefix') }} {{ selected.schedule.everyMinutes }} {{ t('uiAutomationsPanelIdleDurationSuffix') }}
          </p>
          <p v-if="selected.status === 'active' && selected.nextRunAt" class="muted">
            {{ selected.schedule?.type === 'idle' ? t('uiAutomationsPanelExpectedIdleRun') : t('uiAutomationsPanelNextRun') }}：{{ when(selected.nextRunAt) }}
          </p>
          <p class="muted">
            {{ t('uiAutomationsPanelModelLabel') }}{{ selected.configuration.modelOverride || selected.configuration.providerId }}
            {{ t('uiAutomationsPanelWorkspaceLabel') }}{{ selected.configuration.workspace?.name || t('uiAutomationsPanelNone') }}
          </p>
          <template v-if="selected.event">
            <h4>{{ t('uiAutomationsPanelTriggerConditionsHistory') }}</h4>
            <p class="muted">{{ eventSource(selected) }}</p>
            <p class="muted">
              {{ t('uiAutomationsPanelWhileBusy')
              }}{{ selected.event.busyPolicy === 'latest' ? t('uiAutomationsPanelKeepLatestEvent') : t('uiAutomationsPanelSkipNewEvents')
              }}{{ t('uiAutomationsPanelAfterRestartPrefix')
              }}{{ selected.event.restartPolicy === 'resume' ? t('uiAutomationsPanelResumeMonitoring') : t('uiAutomationsPanelPauseUntilResumed') }}。
            </p>
            <p v-if="!selected.recentEvents?.length" class="muted">{{ t('uiAutomationsPanelNoMatchingEvents') }}</p>
            <ol v-else class="event-history">
              <li v-for="event in [...selected.recentEvents!].reverse()" :key="event.key">
                <strong>{{ eventStatus[event.status] }} · {{ when(event.observedAt) }}</strong>
                <p>{{ event.summary }}</p>
                <p v-if="event.reason">{{ event.reason }}</p>
                <small v-if="event.runId">{{ t('uiAutomationsPanelLinkedRunLabel') }}{{ event.runId }}</small>
              </li>
            </ol>
          </template>
          <h4>{{ t('uiAutomationsPanelRecentProgress') }}</h4>
          <p class="automation-progress">{{ selected.progress || t('uiAutomationsPanelTaskResultsHelp') }}</p>
          <p v-if="selected.error" role="alert" class="automations-error">{{ selected.error }}</p>
          <footer class="automation-actions">
            <button @click="action(() => openConversation(selected!.conversationId))">{{ t('uiAutomationsPanelOpenConversation') }}</button>
            <button
              v-if="selected.status === 'paused' && !runActive(selected) && !selected.awaitingBackground"
              :disabled="busy"
              @click="action(() => editTask(selected!))"
            >
              {{ t('uiAutomationsPanelEditTask') }}
            </button>
            <button v-if="selected.status === 'active'" :disabled="busy" @click="action(() => call('automations.pause', { id: selected!.id }))">
              {{ t('uiAutomationsPanelPauseFutureRuns') }}
            </button>
            <button
              v-if="runActive(selected) || selected.awaitingBackground"
              :disabled="busy"
              @click="action(() => call('automations.pause', { id: selected!.id, stopCurrent: true }))"
            >
              {{ t('uiAutomationsPanelStopCurrentRun') }}
            </button>
            <button
              v-if="selected.status === 'paused' && !runActive(selected)"
              class="primary"
              :disabled="busy"
              @click="action(() => call('automations.resume', { id: selected!.id }))"
            >
              {{ t('uiDebugControlsContinue') }}
            </button>
          </footer>
          <div class="automation-remove">
            <button v-if="!confirmRemove" :disabled="busy" @click="confirmRemove = true">{{ t('uiAutomationsPanelRemoveAutomation') }}</button>
            <template v-else>
              <p>{{ t('uiAutomationsPanelRemoveAutomationHelp') }}</p>
              <button :disabled="busy" @click="action(() => call('automations.remove', { id: selected!.id }))">
                {{ t('uiAutomationsPanelConfirmRemoval') }}
              </button>
              <button @click="confirmRemove = false">{{ t('uiBrowserPaneCancel') }}</button>
            </template>
          </div>
        </section>
        <p v-else class="muted empty-automations">{{ t('uiAutomationsPanelSelectAutomationHelp') }}</p>
      </main>
    </div>
  </dialog>
</template>

<style scoped>
.automations-dialog {
  box-sizing: border-box;
  width: min(1160px, calc(100vw - 28px));
  height: min(850px, calc(100dvh - 40px));
  max-width: none;
  max-height: none;
  padding: 0;
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-lg);
  background: var(--gc-surface-raised);
  color: var(--gc-text-primary);
}
.automations-dialog::backdrop {
  background: var(--gc-backdrop);
}
.automations-dialog[open] {
  display: flex;
  flex-direction: column;
}
.automations-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.automations-header > button {
  flex-shrink: 0;
  white-space: nowrap;
}
h2,
h3,
h4,
p {
  margin: 0;
}
h2 {
  font-size: 18px;
}
h3 {
  font-size: 17px;
}
h4 {
  font-size: 13px;
  margin-top: 6px;
}
.automations-header p {
  margin-top: 7px;
  font-size: 12px;
  color: var(--gc-text-muted);
}
button,
input,
select,
textarea {
  box-sizing: border-box;
  font: inherit;
  font-size: 13px;
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  padding: 8px 10px;
  background: var(--gc-surface-input);
  min-width: 0;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.primary {
  background: var(--gc-accent);
  color: white;
  border-color: var(--gc-accent);
}
input,
select,
textarea {
  width: 100%;
}
textarea {
  resize: vertical;
  min-height: 100px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
}
.automations-layout {
  display: grid;
  grid-template-columns: 255px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}
.automations-list {
  overflow: auto;
  padding: 14px;
  border-right: 1px solid var(--gc-border-subtle);
}
.new-automation {
  width: 100%;
  margin-bottom: 10px;
}
.automations-list > select {
  margin-bottom: 12px;
}
.automation-row {
  display: flex;
  flex-direction: column;
  align-items: start;
  text-align: left;
  gap: 7px;
  width: 100%;
  border: 0;
  border-left: 2px solid transparent;
  padding: 12px 10px;
  background: transparent;
}
.automation-row:hover {
  background: var(--gc-surface-hover);
}
.automation-row.selected {
  border-left-color: var(--gc-accent);
  background: color-mix(in srgb, var(--gc-accent) 12%, var(--gc-surface-raised));
}
.automation-row span,
.automation-row small {
  font-size: 11px;
  color: var(--gc-text-muted);
}
.automation-row strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.automation-detail {
  min-width: 0;
  overflow: auto;
  padding: 22px;
}
.automation-form,
.automation-summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.automation-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.muted {
  color: var(--gc-text-muted);
  font-size: 12px;
  line-height: 1.65;
}
.empty-automations {
  padding: 12px 4px;
}
.weekday-options {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  border: 1px solid var(--gc-border-subtle);
  padding: 12px;
  margin: 0;
}
.weekday-options legend {
  font-size: 13px;
}
.weekday-options label {
  flex-direction: row;
  align-items: center;
  gap: 5px;
}
.weekday-options input {
  width: auto;
}
.automation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
}
.automation-title {
  display: flex;
  align-items: start;
  gap: 12px;
  justify-content: space-between;
}
.automation-title h3 {
  overflow-wrap: anywhere;
}
.automation-status {
  font-size: 12px;
  padding: 5px 8px;
  background: var(--gc-surface-hover);
  flex-shrink: 0;
}
.automation-status.active {
  color: var(--gc-accent);
}
.automation-objective,
.automation-progress {
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.automation-progress {
  padding: 14px;
  border: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-input);
}
.event-history {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.event-history li {
  border-left: 2px solid var(--gc-border-subtle);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.event-history p,
.event-history small {
  color: var(--gc-text-muted);
}
.automation-form > .automation-actions {
  position: sticky;
  bottom: -22px;
  z-index: 1;
  padding: 14px 0;
  border-top: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-raised);
}
.automation-statistics {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 12px;
  padding: 16px 0;
  border-block: 1px solid var(--gc-border-subtle);
}
.automation-statistics div {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.automation-statistics small {
  color: var(--gc-text-muted);
  font-size: 12px;
}
.automation-statistics strong {
  font-size: 18px;
}
.automation-statistics strong span {
  font-size: 12px;
  font-weight: 400;
  color: var(--gc-text-muted);
}
.automations-error {
  padding: 12px 20px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--gc-danger);
  border-bottom: 1px solid var(--gc-border-subtle);
  overflow-wrap: anywhere;
}
.automation-remove {
  border-top: 1px solid var(--gc-border-subtle);
  margin-top: 12px;
  padding-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.automation-remove p {
  width: 100%;
  font-size: 12px;
  color: var(--gc-text-muted);
}
@media (max-width: 700px) {
  .automations-dialog {
    width: calc(100vw - 16px);
    height: calc(100dvh - 24px);
  }
  .automations-header {
    padding: 15px;
  }
  .automations-layout {
    display: flex;
    flex-direction: column;
  }
  .automations-list {
    flex-shrink: 0;
    max-height: 24vh;
    border-right: 0;
    border-bottom: 1px solid var(--gc-border-subtle);
    padding: 10px 14px;
  }
  .automation-detail {
    padding: 16px;
  }
  .automation-fields {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .automation-statistics {
    gap: 8px;
  }
  .automation-statistics strong {
    font-size: 15px;
  }
  .automation-title {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
