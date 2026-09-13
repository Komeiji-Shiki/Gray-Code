<script lang="ts">
export interface NodeTaskDraft { text: string; workspaceId: string; agentId: string; selectedRunId: string; request?: { fingerprint: string; key: string } }
</script>
<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import type { ApprovalRequest, NodePeerSummary, NodeTaskDispatch, NodeTaskDiff, PlatformMessage, QuestionRequest, RunRecord } from '@graycode/contracts';
import { call, subscribe } from '../api';
const props = defineProps<{ peer: NodePeerSummary; draft: NodeTaskDraft; visible: boolean }>();
const rows = ref<RunRecord[]>([]); const dispatches = ref<NodeTaskDispatch[]>([]);
const result = ref<{ run: RunRecord; history: { messages: PlatformMessage[] }; approvals: ApprovalRequest[]; questions: QuestionRequest[]; diffs: NodeTaskDiff[] }>();
const diff = ref<{ id: string; filePath: string; originalContent: string; newContent: string }>();
const answers = ref<Record<string, string[]>>({}); const error = ref(''); const busy = ref(false);
const capabilities = computed(() => props.peer.capabilities);
const pending = computed(() => dispatches.value.filter(value => value.state === 'pending'));
const labels: Record<string, string> = { queued:'等待执行', running:'正在执行', awaiting_approval:'等待审批', awaiting_input:'等待回答', completed:'已完成', failed:'失败', cancelled:'已取消', interrupted:'已中断' };
let refreshTimer: ReturnType<typeof setTimeout> | undefined; let generation = 0; let refreshAgain = false;
const remote = <T = any>(method: string, params: Record<string, unknown> = {}) => call<T>('nodes.request', { peerId: props.peer.id, method, params });
async function detail(id: string) {
  const current = ++generation; props.draft.selectedRunId = id;
  const value = await remote('tasks.get', { id }); if (current === generation) result.value = value;
}
async function showDiff(id: string) {
  if (!result.value) return;
  const content = await remote<{ filePath: string; originalContent: string; newContent: string }>('tasks.diff', { id: result.value.run.id, diffId: id });
  diff.value = { id, ...content };
}
async function refresh() {
  dispatches.value = await call('nodes.dispatches', { peerId: props.peer.id });
  if (props.peer.state !== 'online') return;
  rows.value = await remote('tasks.list');
  if (props.draft.selectedRunId) await detail(props.draft.selectedRunId);
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await action(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; if (refreshAgain && props.visible) { refreshAgain = false; void perform(refresh); } }
}
async function start() {
  const text = props.draft.text;
  const fingerprint = JSON.stringify([props.peer.id, props.draft.workspaceId, props.draft.agentId, text]);
  if (props.draft.request?.fingerprint !== fingerprint) props.draft.request = { fingerprint, key: crypto.randomUUID() };
  const run = await call<RunRecord>('nodes.tasks.start', { peerId: props.peer.id, workspaceId: props.draft.workspaceId, agentId: props.draft.agentId, text, requestKey: props.draft.request!.key });
  if (props.draft.text === text) { props.draft.text = ''; props.draft.request = undefined; }
  await detail(run.id); await refresh();
}
const textOf = (message: PlatformMessage) => message.parts.flatMap(part => typeof part.text === 'string' ? [part.text] : []).join('\n');
const toolsOf = (message: PlatformMessage) => message.parts.flatMap(part => part.functionCall ? [part.functionCall] : part.functionResponse ? [part.functionResponse] : []);
watch(() => [props.visible, props.peer.state], () => { if (props.visible) void perform(refresh); }, { immediate: true });
const off = subscribe(event => {
  if (!props.visible || event.type !== 'nodes.event' || event.peerId !== props.peer.id || !['event','message.persisted','run.created','tasks.changed'].includes(event.notification?.type)) return;
  if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; if (!busy.value) void perform(refresh); else refreshAgain = true; }, 250);
});
onUnmounted(() => { off(); clearTimeout(refreshTimer); generation++; });
</script>
<template>
  <div class="node-tasks">
    <p v-if="!capabilities?.tasks" class="node-hint">此设备尚未授予任务权限。请在执行设备重新配对并选择可用项目。</p>
    <form v-else class="node-task-form" @submit.prevent="perform(start)"><div class="node-fields"><label>远端项目<select v-model="draft.workspaceId" aria-label="远端项目"><option value="" disabled>请选择执行项目</option><option v-for="value in capabilities.workspaces" :key="value.id" :value="value.id">{{ value.name }}</option></select></label><label>远端智能体<select v-model="draft.agentId" aria-label="远端智能体"><option value="" disabled>请选择智能体</option><option v-for="value in capabilities.agents" :key="value.id" :value="value.id">{{ value.name }}</option></select></label></div><p v-if="draft.workspaceId" class="node-hint">{{ capabilities.workspaces.find(value=>value.id===draft.workspaceId)?.directory }}</p><label>任务内容<textarea v-model="draft.text" aria-label="远端任务内容" placeholder="描述要在这台设备的所选项目中完成的任务。"></textarea></label><div class="node-row"><button type="submit" :disabled="busy || peer.state!=='online' || !draft.workspaceId || !draft.agentId || !draft.text.trim()">在 {{ peer.name }} 执行</button><button type="button" :disabled="busy" @click="perform(refresh)">刷新任务</button></div></form>
    <p v-if="error" class="node-error" role="alert">{{ error }}</p>
    <div v-for="value in pending" :key="value.id" class="node-pending"><strong>派发结果待确认</strong><p>{{ value.error || '连接恢复后可查询原请求。' }}</p><button :disabled="busy || peer.state!=='online'" @click="perform(async()=>{const run=await call('nodes.tasks.retry',{peerId:peer.id,id:value.id});await detail(run.id);await refresh()})">重试原请求</button></div>
    <div class="node-task-results"><div class="node-run-list"><button v-for="run in rows" :key="run.id" :class="{active:draft.selectedRunId===run.id}" @click="perform(()=>detail(run.id))"><strong>{{ labels[run.status] }}</strong><span>{{ new Date(run.createdAt).toLocaleString() }}</span><small>{{ capabilities?.workspaces.find(value=>value.id===run.workspaceId)?.name || run.workspaceId }} · {{ run.id.slice(0,8) }}</small></button><p v-if="!rows.length" class="node-empty">该设备还没有派发任务。</p></div><div v-if="result" class="node-run-detail"><header><strong>{{ labels[result.run.status] }} · {{ peer.name }}</strong><button v-if="['queued','running','awaiting_input','awaiting_approval'].includes(result.run.status)" :disabled="busy || peer.state!=='online'" @click="perform(async()=>{await remote('tasks.cancel',{id:result!.run.id});await refresh()})">停止任务</button></header><p class="node-hint">账号 {{ capabilities?.account.displayName }} · 项目 {{ capabilities?.workspaces.find(value=>value.id===result?.run.workspaceId)?.name || result.run.workspaceId }}</p><p v-if="result.run.error" class="node-error">{{ result.run.error }}</p>
      <article v-for="message in result.history.messages" :key="message.id" class="node-message"><small>{{ message.role==='user' ? '请求' : message.role==='model' ? '回复' : '工具结果' }}</small><div v-if="textOf(message)" class="node-message-text">{{ textOf(message) }}</div><details v-for="(tool,index) in toolsOf(message)" :key="index"><summary>工具 {{ (tool as any).name || '操作' }}</summary><pre>{{ JSON.stringify(tool,null,2) }}</pre></details></article>
      <section v-for="approval in result.approvals" :key="approval.id" class="node-pending"><strong>等待审批：{{ approval.toolName }}</strong><pre>{{ JSON.stringify(approval.args,null,2) }}</pre><div class="node-row"><button :disabled="busy" @click="perform(async()=>{await remote('tasks.approve',{id:result!.run.id,approvalId:approval.id,accepted:true});await refresh()})">允许执行</button><button :disabled="busy" @click="perform(async()=>{await remote('tasks.approve',{id:result!.run.id,approvalId:approval.id,accepted:false});await refresh()})">拒绝</button></div></section>
      <section v-for="value in result.diffs" :key="value.id" class="node-pending"><strong>待确认的文件修改：{{ value.path }}</strong><p v-if="value.warning" class="node-error">{{ value.warning }}</p><button :disabled="busy" @click="perform(()=>showDiff(value.id))">查看修改内容</button><template v-if="diff?.id===value.id"><label>修改前<pre>{{ diff.originalContent || '新文件' }}</pre></label><label>修改后<pre>{{ diff.newContent }}</pre></label><div class="node-row"><button :disabled="busy" @click="perform(async()=>{await remote('tasks.resolveDiff',{id:result!.run.id,diffId:value.id,accepted:true});diff=undefined;await refresh()})">接受并写入远端文件</button><button :disabled="busy" @click="perform(async()=>{await remote('tasks.resolveDiff',{id:result!.run.id,diffId:value.id,accepted:false});diff=undefined;await refresh()})">拒绝修改</button></div></template></section>
      <section v-for="question in result.questions" :key="question.id" class="node-pending"><label v-for="(item,index) in question.questions" :key="index">{{ item.title }}<input :value="answers[question.id]?.[index] || ''" @input="(answers[question.id] ||= [])[index]=($event.target as HTMLInputElement).value" :list="`node-answer-${question.id}-${index}`"><datalist :id="`node-answer-${question.id}-${index}`"><option v-for="option in item.options" :key="option" :value="option" /></datalist></label><button :disabled="busy" @click="perform(async()=>{await remote('tasks.answer',{id:result!.run.id,questionId:question.id,answers:question.questions.map((_,i)=>answers[question.id]?.[i] || '')});await refresh()})">提交回答</button></section>
    </div></div>
  </div>
</template>
