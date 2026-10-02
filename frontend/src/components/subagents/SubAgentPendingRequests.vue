<script setup lang="ts">
/**
 * 主对话中显示本对话派发的子代理正在等待的审批和问题。
 * 子代理调用需要确认的工具（例如删除文件）时会暂停，用户不必打开监视器就能在这里处理。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ApprovalRequest, QuestionRequest } from '../../../../packages/contracts/src/runtime';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';

type Source = { subagentRunId: string; agentName: string };
type Approval = ApprovalRequest & Source;
type Question = QuestionRequest & Source;

const props = defineProps<{ conversationId: string | null }>();
const approvals = ref<Approval[]>([]);
const questions = ref<Question[]>([]);
const answers = ref<Record<string, string[]>>({});
const busy = ref('');
const error = ref('');
let epoch = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const visible = computed(() => approvals.value.length > 0 || questions.value.length > 0 || !!error.value);

async function refresh() {
  const current = ++epoch;
  const conversationId = props.conversationId;
  if (!conversationId) { approvals.value = []; questions.value = []; return; }
  try {
    const result = await sendToExtension<{ approvals: Approval[]; questions: Question[] }>('subagents.pendingRequests', { conversationId });
    if (disposed || current !== epoch || props.conversationId !== conversationId) return;
    // 宿主未提供该接口或返回结构不完整时不显示面板，也不影响对话其余界面。
    approvals.value = Array.isArray(result?.approvals) ? result.approvals : [];
    questions.value = Array.isArray(result?.questions) ? result.questions : [];
    error.value = '';
    for (const question of questions.value) answers.value[question.id] ??= question.questions.map(() => '');
  } catch (cause) {
    if (!disposed && current === epoch && props.conversationId === conversationId) error.value = (cause as Error).message;
  }
}
// 同一时刻的多个子代理事件合并为一次读取。
function scheduleRefresh() {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void refresh(); }, 50);
}

function summary(approval: Approval): string {
  if (approval.reason) return approval.reason;
  const paths = approval.args.paths ?? approval.args.path ?? approval.args.files;
  if (Array.isArray(paths)) return paths.map(item => typeof item === 'string' ? item : (item as { path?: string })?.path ?? JSON.stringify(item)).join('\n');
  if (typeof paths === 'string') return paths;
  if (typeof approval.args.command === 'string') return approval.args.command;
  return JSON.stringify(approval.args, null, 2);
}

async function submit(request: Approval | Question, accepted?: boolean, choiceId?: string) {
  if (busy.value) return;
  busy.value = request.id; error.value = '';
  try {
    if (accepted === undefined) {
      await sendToExtension('subagents.answerQuestion', { runId: request.subagentRunId, id: request.id, answers: answers.value[request.id] });
    } else {
      await sendToExtension('subagents.resolveApproval', { runId: request.subagentRunId, id: request.id, accepted, choiceId });
    }
    await refresh();
  } catch (cause) { if (!disposed) error.value = (cause as Error).message; }
  finally { busy.value = ''; }
}

watch(() => props.conversationId, () => {
  // 等待新对话的列表期间不能继续展示或提交旧对话的请求。
  approvals.value = []; questions.value = []; error.value = '';
  void refresh();
}, { immediate: true });

const unsubscribe = onMessageFromExtension((message: any) => {
  if (message.type === 'platformQuestionsChanged') { scheduleRefresh(); return; }
  const event = message.type === 'subagentMonitor.event' ? message.data?.event : undefined;
  if (event && /^(approval_|question_|run_)/.test(String(event.type))) scheduleRefresh();
});
onBeforeUnmount(() => { disposed = true; epoch++; if (timer) clearTimeout(timer); unsubscribe(); });
</script>

<template>
  <section v-if="visible" class="subagent-pending" aria-label="子代理等待处理的请求">
    <article v-for="approval in approvals" :key="approval.id" class="pending-item" role="group" :aria-label="`${approval.agentName} 请求确认 ${approval.toolName}`">
      <header>
        <i class="codicon codicon-hubot" aria-hidden="true"></i>
        <strong>{{ approval.agentName }}</strong>
        <span>请求确认操作 · {{ approval.toolName }}</span>
      </header>
      <pre>{{ summary(approval) }}</pre>
      <footer v-if="approval.choices?.length">
        <button v-for="choice in approval.choices" :key="choice.id" type="button" :disabled="!!busy"
          :class="{ primary: choice.kind === 'allow_once' }" @click="submit(approval, choice.kind.startsWith('allow'), choice.id)">{{ choice.label }}</button>
      </footer>
      <footer v-else>
        <button type="button" :disabled="!!busy" @click="submit(approval, false)">拒绝</button>
        <button type="button" class="primary" :disabled="!!busy" :aria-busy="busy === approval.id" @click="submit(approval, true)">允许执行</button>
      </footer>
    </article>
    <article v-for="request in questions" :key="request.id" class="pending-item" role="group" :aria-label="`${request.agentName} 的问题`">
      <header>
        <i class="codicon codicon-hubot" aria-hidden="true"></i>
        <strong>{{ request.agentName }}</strong>
        <span>需要补充的信息</span>
      </header>
      <label v-for="(question, index) in request.questions" :key="index">
        <span>{{ question.title }}</span>
        <div v-if="question.options?.length" class="answer-options">
          <button v-for="option in question.options" :key="option" type="button"
            :class="{ selected: answers[request.id]?.[index] === option }" @click="answers[request.id][index] = option">{{ option }}</button>
        </div>
        <input v-model="answers[request.id][index]" placeholder="填写你的回答…" :aria-label="question.title" />
      </label>
      <footer>
        <button type="button" class="primary" :disabled="!!busy || answers[request.id]?.some(answer => !answer.trim())"
          :aria-busy="busy === request.id" @click="submit(request)">提交回答</button>
      </footer>
    </article>
    <p v-if="error" class="pending-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.subagent-pending { padding: 8px 16px 0; max-height: 42vh; overflow: auto; display: grid; gap: 8px; }
.pending-item { padding: 12px 14px; border: 1px solid var(--gc-border-control); border-left: 3px solid var(--gc-warning, var(--gc-accent)); background: var(--gc-surface-raised); }
header { display: flex; align-items: center; gap: 6px; font-size: 13px; flex-wrap: wrap; }
header span { color: var(--gc-text-muted); }
pre { max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin: 10px 0 0; }
label { display: grid; gap: 7px; margin-top: 12px; font-size: 13px; }
footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
input, button { font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-input, var(--gc-surface-base)); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); padding: 6px 12px; }
button { cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.primary, .answer-options .selected { background: var(--gc-button-primary); color: var(--gc-text-on-primary); border-color: transparent; }
.answer-options { display: flex; flex-wrap: wrap; gap: 6px; }
.pending-error { font-size: 12px; color: var(--gc-danger); margin: 0; }
</style>
