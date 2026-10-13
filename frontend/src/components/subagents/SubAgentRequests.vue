<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';
import type { ApprovalRequest as Approval, QuestionRequest as Question } from '../../../../packages/contracts/src/runtime';
const props = defineProps<{ runId: string }>();
const approvals = ref<Approval[]>([]);
const questions = ref<Question[]>([]);
const answers = ref<Record<string, string[]>>({});
const busy = ref(new Set<string>());
const requestErrors = ref(new Map<string, string>());
const error = ref('');
let requestSequence = 0;
let runGeneration = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function cancelScheduledRefresh() {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

function scheduleRefresh() {
  // 一次请求结算可能连发审批、问题和运行事件，只保留一次列表读取。
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void load();
  }, 50);
}

async function load() {
  cancelScheduledRefresh();
  const sequence = ++requestSequence;
  const id = props.runId;
  try {
    const result = await sendToExtension('subagents.monitor.requests', { runId: id });
    if (sequence !== requestSequence || id !== props.runId) return;
    approvals.value = result.approvals;
    questions.value = result.questions;
    error.value = '';
    for (const question of result.questions) answers.value[question.id] ??= question.questions.map(() => '');
  } catch (cause) {
    if (sequence === requestSequence && id === props.runId) error.value = (cause as Error).message;
  }
}
async function submit(id: string, accepted?: boolean, choiceId?: string) {
  if (busy.value.has(id)) return;
  const runId = props.runId;
  const generation = runGeneration;
  busy.value.add(id);
  requestErrors.value.delete(id);
  // 审批与回答由服务端按请求 ID 独立结算；旧运行的回复不能清除新运行的忙状态。
  const isCurrent = () => generation === runGeneration && props.runId === runId;
  try {
    if (accepted === undefined) {
      await sendToExtension('subagents.answerQuestion', { runId, id, answers: answers.value[id] });
    } else {
      await sendToExtension('subagents.resolveApproval', { runId, id, accepted, choiceId });
    }
    if (isCurrent()) await load();
  } catch (cause) {
    if (isCurrent()) requestErrors.value.set(id, (cause as Error).message);
  } finally {
    if (isCurrent()) busy.value.delete(id);
  }
}
watch(() => props.runId, () => {
  runGeneration++;
  cancelScheduledRefresh();
  approvals.value = [];
  questions.value = [];
  answers.value = {};
  error.value = '';
  busy.value.clear();
  requestErrors.value.clear();
  void load();
}, { immediate: true });
const unsubscribe = onMessageFromExtension((message: any) => {
  const event = message.type === 'subagentMonitor.event' ? message.data?.event : undefined;
  if (event?.runId === props.runId && /^(approval_|question_|run_)/.test(event.type)) scheduleRefresh();
});
onBeforeUnmount(() => {
  requestSequence++;
  runGeneration++;
  cancelScheduledRefresh();
  unsubscribe();
});
</script>
<template>
  <section v-if="approvals.length || questions.length || error" class="subagent-requests">
    <article v-for="approval in approvals" :key="approval.id"><header><strong>待确认操作 · {{ approval.toolName }}</strong></header>
      <pre>{{ approval.reason || JSON.stringify(approval.args, null, 2) }}</pre>
      <p v-if="requestErrors.has(approval.id)" class="request-error" role="alert">{{ requestErrors.get(approval.id) }}</p>
      <footer v-if="approval.choices?.length"><button v-for="choice in approval.choices" :key="choice.id" :disabled="busy.has(approval.id)"
        @click="submit(approval.id, choice.kind.startsWith('allow'), choice.id)">{{ choice.label }}</button></footer>
      <footer v-else>
        <button :disabled="busy.has(approval.id)" @click="submit(approval.id, false)">拒绝</button>
        <button class="primary" :disabled="busy.has(approval.id)" @click="submit(approval.id, true)">允许执行</button>
      </footer>
    </article>
    <article v-for="request in questions" :key="request.id"><strong>子 agent 的问题</strong>
      <label v-for="(question,index) in request.questions" :key="index"><span>{{ question.title }}</span>
        <div v-if="question.options?.length" class="answer-options">
          <button v-for="option in question.options" :key="option"
            :class="{ selected: answers[request.id]?.[index] === option }"
            @click="answers[request.id][index] = option">{{ option }}</button>
        </div>
        <input v-model="answers[request.id][index]" placeholder="输入回答，也可以补充说明" :aria-label="question.title" />
      </label>
      <p v-if="requestErrors.has(request.id)" class="request-error" role="alert">{{ requestErrors.get(request.id) }}</p>
      <footer><button class="primary" :disabled="busy.has(request.id)" @click="submit(request.id)">提交回答</button></footer>
    </article>
    <p v-if="error" class="request-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.subagent-requests {
  margin: 12px 0 18px;
}
.subagent-requests article {
  border: 1px solid var(--gc-border-control);
  padding: 14px;
  margin-top: 10px;
  background: var(--gc-surface-panel);
}
strong {
  font-size: 13px;
}
pre {
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  margin: 12px 0;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
label {
  display: grid;
  gap: 9px;
  margin-top: 15px;
  font-size: 13px;
}
input, button {
  font: inherit;
  color: var(--gc-text-primary);
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  padding: 8px 10px;
}
button {
  cursor: pointer;
}
.primary, .answer-options .selected {
  background: var(--gc-button-primary);
  color: var(--gc-text-on-primary);
}
.answer-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.request-error {
  font-size: 12px;
  color: var(--gc-danger);
}
</style>
