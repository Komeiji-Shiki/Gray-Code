<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { AutomationCreate, AutomationOptions, AutomationSchedule, AutomationView } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { state } from '../state';
import AutomationEventFields from './AutomationEventFields.vue';
import { eventForm, eventConfiguration } from './automationEventForm';
import { reasoningLevelsForModel } from '../../../../shared/reasoningEffort';

const props = defineProps<{ open: boolean }>();
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
const form = reactive({ kind: 'goal' as AutomationCreate['kind'], name: '', objective: '', target: 'new', agentId: '', providerId: '', modelId: '', promptModeId: '',
  reasoningEffort: '', workspaceId: '', cadence: 'once', at: '', everyMinutes: '', time: '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  weekDays: [] as number[], missedRunPolicy: '', event: eventForm() });
const selected = computed(() => rows.value.find(row => row.id === selectedId.value));
const visibleRows = computed(() => rows.value.filter(row => filter.value === 'all' || row.kind === filter.value));
const profile = computed(() => options.value?.providers.find(provider => provider.id === form.providerId));
const modelChoices = computed(() => [...new Set([profile.value?.model, ...profile.value?.models.map(model => model.id) ?? []].filter(Boolean))]);
const reasoningLevels = computed(() => profile.value ? reasoningLevelsForModel(profile.value, form.modelId) : []);
const currentOccupied = computed(() => rows.value.some(row => row.conversationId === options.value?.current.conversationId && row.status !== 'completed'));
const weekDays = [{ id: 1, name: '一' }, { id: 2, name: '二' }, { id: 3, name: '三' }, { id: 4, name: '四' }, { id: 5, name: '五' }, { id: 6, name: '六' }, { id: 0, name: '日' }];
const when = (value?: number) => value ? new Date(value).toLocaleString() : '—';
const used = (row: AutomationView) => row.usage.inputTokens + row.usage.outputTokens;
const runActive = (row: AutomationView) => ['queued', 'running', 'awaiting_input', 'awaiting_approval'].includes(row.runStatus ?? '');
function status(row: AutomationView) {
  if (row.runStatus === 'awaiting_input') return '等待回答';
  if (row.runStatus === 'awaiting_approval') return '等待确认';
  if (runActive(row)) return row.status === 'paused' ? '本轮结束后暂停' : '正在执行';
  if (row.status === 'completed') return '已完成';
  if (row.status === 'paused') return ({ restart: '重启后等待继续', error: '发生错误', input: '需要补充信息', user: '已暂停' })[row.pauseReason ?? 'user'];
  return row.awaitingBackground ? '等待子任务结果' : row.kind === 'goal' ? '准备继续' : '等待触发';
}
async function refresh() {
  const epoch = ++refreshEpoch;
  try {
    const result = await call<AutomationView[]>('automations.list');
    if (epoch !== refreshEpoch) return;
    rows.value = result;
    if (!selectedId.value || !result.some(row => row.id === selectedId.value)) select(result[0]);
  } catch (cause) { if (epoch === refreshEpoch) error.value = (cause as Error).message; }
}
function select(row?: AutomationView) { selectedId.value = row?.id ?? ''; confirmRemove.value = false; }
async function newTask() {
  if (editingId.value) { form.objective = ''; form.name = ''; }
  editingId.value = '';
  const epoch = ++formEpoch;
  const conversationId = form.objective && options.value ? options.value.current.conversationId : state.conversationId || undefined;
  error.value = ''; const loaded = await call<AutomationOptions>('automations.options', { conversationId });
  if (epoch !== formEpoch || !props.open) return;
  options.value = loaded;
  const current = options.value.current;
  if (!form.objective) Object.assign(form, { target: current.conversationId && !currentOccupied.value ? 'current' : 'new', agentId: current.agentId,
    providerId: current.providerId, modelId: current.modelId, promptModeId: current.promptModeId, reasoningEffort: current.reasoningEffort ?? '',
    workspaceId: options.value.workspaces.some(workspace => workspace.id === current.workspaceId) ? current.workspaceId : '' });
  creating.value = true;
}
async function editTask(row: AutomationView) {
  const epoch = ++formEpoch;
  const loaded = await call<AutomationOptions>('automations.options', { conversationId: row.conversationId });
  if (epoch !== formEpoch || !props.open) return;
  options.value = loaded; editingId.value = row.id;
  const source = row.schedule;
  const at = source?.type === 'once' ? source.at : source?.type === 'interval' ? source.startAt : undefined;
  const localTime = at ? new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  Object.assign(form, { kind: row.kind, name: row.name, objective: row.objective, target: 'current', agentId: row.agentId,
    providerId: row.configuration.providerId, modelId: row.configuration.modelOverride ?? '', promptModeId: row.configuration.promptModeId ?? '',
    reasoningEffort: row.configuration.reasoningEffort ?? '',
    cadence: source?.type === 'daily' && source.weekDays ? 'weekly' : source?.type ?? 'once', at: localTime,
    everyMinutes: source?.type === 'interval' ? String(source.everyMinutes) : '', time: source?.type === 'daily' ? source.time : '',
    timeZone: source?.type === 'daily' ? source.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekDays: source?.type === 'daily' ? [...source.weekDays ?? []] : [], missedRunPolicy: row.missedRunPolicy ?? '', event: eventForm(row.event) });
  creating.value = true;
}
async function opened() {
  await nextTick(); if (!props.open) return;
  if (!dialog.value?.open) dialog.value?.showModal();
  await refresh();
  if (rows.value.length && !creating.value) { try { options.value = await call<AutomationOptions>('automations.options'); } catch (cause) { error.value = (cause as Error).message; } }
  if (!rows.value.length && !creating.value) { try { await newTask(); } catch (cause) { error.value = (cause as Error).message; } }
}
watch(() => props.open, open => {
  if (open) void opened();
  else { refreshEpoch++; formEpoch++; dialog.value?.close(); if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = undefined; }
});
onMounted(() => { if (props.open) void opened(); });
const unsubscribe = subscribe(event => {
  if (!props.open || event.type !== 'automation.changed' || refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 120);
});
onUnmounted(() => { refreshEpoch++; formEpoch++; unsubscribe(); if (refreshTimer) clearTimeout(refreshTimer); });
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await operation(); await refresh(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function schedule(): AutomationSchedule | undefined {
  if (form.kind !== 'schedule') return;
  if (form.cadence === 'once') return { type: 'once', at: new Date(form.at).getTime() };
  if (form.cadence === 'interval') return { type: 'interval', startAt: new Date(form.at).getTime(), everyMinutes: Number(form.everyMinutes) };
  return { type: 'daily', time: form.time, timeZone: form.timeZone, ...(form.cadence === 'weekly' ? { weekDays: [...form.weekDays] } : {}) };
}
async function create() {
  const created = await call<AutomationView>(editingId.value ? 'automations.update' : 'automations.create', { ...(editingId.value ? { id: editingId.value } : {}), kind: form.kind, name: form.name, objective: form.objective, agentId: form.agentId,
    providerId: form.providerId, modelOverride: form.modelId, promptModeId: form.promptModeId || undefined, reasoningEffort: form.reasoningEffort || undefined,
    conversationId: form.target === 'current' ? options.value?.current.conversationId : undefined,
    workspaceId: form.target === 'new' ? form.workspaceId || undefined : undefined,
    event: form.kind === 'event' ? eventConfiguration(form.event) : undefined,
    schedule: schedule(), missedRunPolicy: form.kind === 'schedule' ? form.missedRunPolicy : undefined });
  creating.value = false; editingId.value = ''; form.objective = ''; form.name = ''; select(created);
}
async function openConversation(id: string) { await call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } }); emit('close'); }
const eventStatus = { pending: '等待执行', running: '正在执行', completed: '已完成', failed: '失败', interrupted: '中断', cancelled: '已取消', skipped: '已跳过' };
function eventSource(row: AutomationView) {
  const trigger = row.event?.trigger;
  return trigger?.type === 'file_changed' ? `文件变化：${trigger.path}` : trigger?.type === 'node_online'
    ? `设备上线：${options.value?.eventPeers?.find(item => item.id === trigger.peerId)?.name ?? trigger.peerId}`
    : trigger?.type === 'run_completed' ? `任务完成：${options.value?.eventConversations?.find(item => item.id === trigger.conversationId)?.title ?? trigger.conversationId}` : '';
}
function providerChanged() { form.modelId = profile.value?.model ?? ''; form.reasoningEffort = ''; }
</script>

<template>
  <dialog ref="dialog" class="automations-dialog" aria-labelledby="automations-title" @cancel.prevent="emit('close')">
    <header class="automations-header"><div><h2 id="automations-title">自动任务</h2><p>长期目标、定时执行与事件触发，进度保留在关联对话中。</p></div><button aria-label="关闭自动任务" @click="emit('close')">关闭</button></header>
    <div v-if="error" class="automations-error" role="alert">{{ error }}</div>
    <div class="automations-layout">
      <aside class="automations-list">
        <button class="primary new-automation" :disabled="busy" @click="action(newTask)">新建自动任务</button>
        <select v-model="filter" aria-label="筛选自动任务"><option value="all">全部任务</option><option value="goal">长期目标</option><option value="schedule">定时任务</option><option value="event">事件任务</option></select>
        <button v-for="row in visibleRows" :key="row.id" class="automation-row" :class="{ selected: row.id === selectedId && !creating }" @click="select(row); creating = false">
          <span>{{ row.kind === 'goal' ? '目标' : row.kind === 'event' ? '事件' : '定时' }} · {{ status(row) }}</span><strong>{{ row.name }}</strong><small>{{ used(row).toLocaleString() }} Token · {{ row.completedRuns }} 轮</small>
        </button>
        <p v-if="!visibleRows.length" class="muted empty-automations">还没有{{ filter === 'goal' ? '长期目标' : filter === 'schedule' ? '定时任务' : filter === 'event' ? '事件任务' : '自动任务' }}。</p>
      </aside>
      <main class="automation-detail">
        <form v-if="creating && options" class="automation-form" @submit.prevent="action(create)">
          <h3>{{ editingId ? '编辑自动任务' : '新建自动任务' }}</h3>
          <label>执行方式<select v-model="form.kind" :disabled="!!editingId" aria-label="自动任务执行方式"><option value="goal">长期目标：持续推进，直到完成或暂停</option><option value="schedule">定时任务：按指定时间或周期执行</option><option value="event">事件任务：满足条件后执行</option></select></label>
          <label>名称<input v-model="form.name" placeholder="可选，留空时使用目标的第一行" /></label>
          <label>{{ form.kind === 'goal' ? '长期目标' : '每次执行的任务' }}<textarea v-model="form.objective" rows="5" required placeholder="写明要完成的工作、限制和完成标准" aria-label="自动任务目标"></textarea></label>
          <div class="automation-fields"><label>关联对话<select v-model="form.target" :disabled="!!editingId"><option value="current" :disabled="!options.current.conversationId || currentOccupied && !editingId">当前对话{{ currentOccupied && !editingId ? '（已有未完成的自动任务）' : '' }}</option><option value="new">创建一个新对话</option></select></label>
            <label v-if="form.target === 'new'">工作区<select v-model="form.workspaceId"><option value="">为新对话创建独立目录</option><option v-for="workspace in options.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label></div>
          <div class="automation-fields"><label>智能体<select v-model="form.agentId" required><option v-for="agent in options.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
            <label>预设<select v-model="form.promptModeId"><option value="">沿用对话或智能体预设</option><option v-for="mode in options.promptModes" :key="mode.id" :value="mode.id">{{ mode.name }}</option></select></label></div>
          <div class="automation-fields"><label>模型渠道<select v-model="form.providerId" required @change="providerChanged"><option value="" disabled>请选择渠道</option><option v-for="provider in options.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label>
            <label>模型<input v-model="form.modelId" list="automation-models" required placeholder="选择或输入模型 ID" /><datalist id="automation-models"><option v-for="model in modelChoices" :key="model" :value="model"></option></datalist></label></div>
          <label v-if="reasoningLevels.length">思考强度<select v-model="form.reasoningEffort"><option value="">沿用渠道设置</option><option v-for="level in reasoningLevels" :key="level" :value="level">{{ level }}</option></select></label>
          <template v-if="form.kind === 'schedule'">
            <h4>触发时间</h4>
            <label>重复方式<select v-model="form.cadence"><option value="once">只执行一次</option><option value="interval">按分钟间隔</option><option value="daily">每天</option><option value="weekly">指定星期</option></select></label>
            <label v-if="form.cadence === 'once' || form.cadence === 'interval'">{{ form.cadence === 'once' ? '执行时间' : '首次执行时间' }}（当前设备时间）<input v-model="form.at" type="datetime-local" required /></label>
            <label v-if="form.cadence === 'interval'">间隔分钟<input v-model="form.everyMinutes" type="number" min="1" step="1" required /></label>
            <div v-if="form.cadence === 'daily' || form.cadence === 'weekly'" class="automation-fields"><label>每天的时间<input v-model="form.time" type="time" required /></label><label>时区<input v-model="form.timeZone" required placeholder="Asia/Shanghai" /></label></div>
            <fieldset v-if="form.cadence === 'weekly'" class="weekday-options"><legend>执行星期</legend><label v-for="day in weekDays" :key="day.id"><input v-model="form.weekDays" type="checkbox" :value="day.id" />周{{ day.name }}</label></fieldset>
            <label>应用关闭期间错过时间<select v-model="form.missedRunPolicy" required><option value="" disabled>请选择处理方式</option><option value="skip">跳过，等待下次触发</option><option value="once">重开后补一次，不逐次补跑</option></select></label>
          </template>
          <AutomationEventFields v-else-if="form.kind === 'event'" v-model="form.event" :options="options" />
          <p v-else class="muted">长期目标在应用重启后保留进度并暂停，由你手动继续。</p>
          <footer class="automation-actions"><button type="button" @click="creating = false">返回列表</button><button class="primary" :disabled="busy" type="submit">{{ editingId ? '保存更改，保持暂停' : form.kind === 'goal' ? '创建并开始' : form.kind === 'event' ? '创建并监听事件' : '创建定时任务' }}</button></footer>
        </form>
        <section v-else-if="selected" class="automation-summary">
          <div class="automation-title"><h3>{{ selected.name }}</h3><span :class="['automation-status', selected.status]">{{ status(selected) }}</span></div>
          <p class="automation-objective">{{ selected.objective }}</p>
          <div class="automation-statistics"><div><small>累计 Token</small><strong>{{ used(selected).toLocaleString() }}</strong></div><div><small>已完成轮次</small><strong>{{ selected.completedRuns }}</strong></div><div><small>模型调用</small><strong>{{ selected.usage.requests }}</strong></div></div>
          <p class="muted">输入 {{ selected.usage.inputTokens.toLocaleString() }} · 输出 {{ selected.usage.outputTokens.toLocaleString() }} · 缓存命中 {{ selected.usage.cachedInputTokens.toLocaleString() }}（已包含在输入中）</p>
          <p v-if="selected.usage.estimatedRequests" class="muted">其中 {{ selected.usage.estimatedRequests }} 次调用包含本地估算<span v-if="selected.usage.unknownRequests">，{{ selected.usage.unknownRequests }} 次失败请求无法确认上游最终用量</span>。</p>
          <p v-if="selected.status === 'active' && selected.nextRunAt" class="muted">下次执行：{{ when(selected.nextRunAt) }}</p>
          <p class="muted">模型：{{ selected.configuration.modelOverride || selected.configuration.providerId }} · 工作区：{{ selected.configuration.workspace?.name || '无' }}</p>
          <template v-if="selected.event">
            <h4>触发条件与记录</h4><p class="muted">{{ eventSource(selected) }}</p>
            <p class="muted">忙碌时{{ selected.event.busyPolicy === 'latest' ? '合并为最新事件' : '跳过新事件' }}；重启后{{ selected.event.restartPolicy === 'resume' ? '继续监听' : '暂停等待继续' }}。</p>
            <p v-if="!selected.recentEvents?.length" class="muted">还没有收到符合条件的事件。</p>
            <ol v-else class="event-history"><li v-for="event in [...selected.recentEvents!].reverse()" :key="event.key"><strong>{{ eventStatus[event.status] }} · {{ when(event.observedAt) }}</strong><p>{{ event.summary }}</p><p v-if="event.reason">{{ event.reason }}</p><small v-if="event.runId">关联运行：{{ event.runId }}</small></li></ol>
          </template>
          <h4>最近进度</h4><p class="automation-progress">{{ selected.progress || '任务结果会保留在关联对话中。' }}</p>
          <p v-if="selected.error" role="alert" class="automations-error">{{ selected.error }}</p>
          <footer class="automation-actions">
            <button @click="action(() => openConversation(selected!.conversationId))">打开对话</button>
            <button v-if="selected.status === 'paused' && !runActive(selected) && !selected.awaitingBackground" :disabled="busy" @click="action(() => editTask(selected!))">编辑任务</button>
            <button v-if="selected.status === 'active'" :disabled="busy" @click="action(() => call('automations.pause', { id: selected!.id }))">暂停后续执行</button>
            <button v-if="runActive(selected) || selected.awaitingBackground" :disabled="busy" @click="action(() => call('automations.pause', { id: selected!.id, stopCurrent: true }))">停止当前执行</button>
            <button v-if="selected.status === 'paused' && !runActive(selected)" class="primary" :disabled="busy" @click="action(() => call('automations.resume', { id: selected!.id }))">继续</button>
          </footer>
          <div class="automation-remove"><button v-if="!confirmRemove" :disabled="busy" @click="confirmRemove = true">移除自动任务</button><template v-else><p>将停止相关运行并移除自动任务，对话和历史保留。</p><button :disabled="busy" @click="action(() => call('automations.remove', { id: selected!.id }))">确认移除</button><button @click="confirmRemove = false">取消</button></template></div>
        </section>
        <p v-else class="muted empty-automations">选择一个任务查看进度，或创建新的长期目标、定时或事件任务。</p>
      </main>
    </div>
  </dialog>
</template>

<style scoped>
.automations-dialog { box-sizing: border-box; width: min(1160px, calc(100vw - 28px)); height: min(850px, calc(100dvh - 40px)); max-width: none; max-height: none; padding: 0; border: 1px solid var(--border); border-radius: 0; background: var(--panel); color: var(--text); }
.automations-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.automations-dialog[open] { display: flex; flex-direction: column; }
.automations-header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 20px 22px; border-bottom: 1px solid var(--border); }
.automations-header > button { flex-shrink: 0; white-space: nowrap; }
h2, h3, h4, p { margin: 0; } h2 { font-size: 18px; } h3 { font-size: 17px; } h4 { font-size: 13px; margin-top: 6px; }.automations-header p { margin-top: 7px; font-size: 12px; color: var(--muted); }
button, input, select, textarea { box-sizing: border-box; font: inherit; font-size: 13px; color: var(--text); border: 1px solid var(--border); border-radius: 0; padding: 8px 10px; background: var(--bg); min-width: 0; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } .primary { background: var(--accent); color: white; border-color: var(--accent); }
input, select, textarea { width: 100%; } textarea { resize: vertical; min-height: 100px; } label { display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
.automations-layout { display: grid; grid-template-columns: 255px minmax(0, 1fr); min-height: 0; flex: 1; }
.automations-list { overflow: auto; padding: 14px; border-right: 1px solid var(--border); }.new-automation { width: 100%; margin-bottom: 10px; }.automations-list > select { margin-bottom: 12px; }
.automation-row { display: flex; flex-direction: column; align-items: start; text-align: left; gap: 7px; width: 100%; border: 0; border-left: 2px solid transparent; padding: 12px 10px; background: transparent; }.automation-row:hover { background: var(--hover); }.automation-row.selected { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }.automation-row span, .automation-row small { font-size: 11px; color: var(--muted); }.automation-row strong { font-size: 13px; overflow-wrap: anywhere; }
.automation-detail { min-width: 0; overflow: auto; padding: 22px; }.automation-form, .automation-summary { display: flex; flex-direction: column; gap: 16px; }.automation-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }.muted { color: var(--muted); font-size: 12px; line-height: 1.65; }.empty-automations { padding: 12px 4px; }
.weekday-options { display: flex; flex-wrap: wrap; gap: 14px; border: 1px solid var(--border); padding: 12px; margin: 0; }.weekday-options legend { font-size: 13px; }.weekday-options label { flex-direction: row; align-items: center; gap: 5px; }.weekday-options input { width: auto; }
.automation-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }.automation-title { display: flex; align-items: start; gap: 12px; justify-content: space-between; }.automation-title h3 { overflow-wrap: anywhere; }.automation-status { font-size: 12px; padding: 5px 8px; background: var(--hover); flex-shrink: 0; }.automation-status.active { color: var(--accent); }.automation-objective, .automation-progress { font-size: 13px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }.automation-progress { padding: 14px; border: 1px solid var(--border); background: var(--bg); }
.event-history { list-style: none; padding: 0; margin: 0; max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }.event-history li { border-left: 2px solid var(--border); padding: 10px 12px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }.event-history p, .event-history small { color: var(--muted); }
.automation-form > .automation-actions { position: sticky; bottom: -22px; z-index: 1; padding: 14px 0; border-top: 1px solid var(--border); background: var(--panel); }
.automation-statistics { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; padding: 16px 0; border-block: 1px solid var(--border); }.automation-statistics div { display: flex; flex-direction: column; gap: 8px; }.automation-statistics small { color: var(--muted); font-size: 12px; }.automation-statistics strong { font-size: 18px; }.automation-statistics strong span { font-size: 12px; font-weight: 400; color: var(--muted); }
.automations-error { padding: 12px 20px; font-size: 13px; line-height: 1.6; color: var(--error, #df7b84); border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }.automation-remove { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }.automation-remove p { width: 100%; font-size: 12px; color: var(--muted); }
@media (max-width: 700px) { .automations-dialog { width: calc(100vw - 16px); height: calc(100dvh - 24px); }.automations-header { padding: 15px; }.automations-layout { display: flex; flex-direction: column; }.automations-list { flex-shrink: 0; max-height: 24vh; border-right: 0; border-bottom: 1px solid var(--border); padding: 10px 14px; }.automation-detail { padding: 16px; }.automation-fields { grid-template-columns: 1fr; gap: 16px; }.automation-statistics { gap: 8px; }.automation-statistics strong { font-size: 15px; }.automation-title { flex-direction: column; gap: 8px; } }
</style>
