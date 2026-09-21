<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';
import type { ApprovalRequest as Approval } from '../../../../packages/contracts/src/runtime';
interface Question { id: string; questions: { title: string; options?: string[] }[] }
const props = defineProps<{ runId: string }>();
const approvals = ref<Approval[]>([]); const questions = ref<Question[]>([]);
const answers = ref<Record<string, string[]>>({}); const busy = ref(''); const error = ref('');
let requestSequence = 0;
async function load() {
  const sequence = ++requestSequence; const id = props.runId;
  try {
    const result = await sendToExtension<{ approvals: Approval[]; questions: Question[] }>('subagents.monitor.requests', { runId: id });
    if (sequence !== requestSequence || id !== props.runId) return;
    approvals.value = result.approvals; questions.value = result.questions;
    for (const question of result.questions) answers.value[question.id] ??= question.questions.map(() => '');
  } catch (cause) { if (sequence === requestSequence) error.value = (cause as Error).message; }
}
async function submit(id: string, accepted?: boolean, choiceId?: string) {
  if (busy.value) return; busy.value = id; error.value = '';
  try {
    await sendToExtension(accepted === undefined ? 'subagents.answerQuestion' : 'subagents.resolveApproval', {
      runId: props.runId, id, ...(accepted === undefined ? { answers: answers.value[id] } : { accepted, choiceId }),
    });
    await load();
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = ''; }
}
watch(() => props.runId, () => { approvals.value = []; questions.value = []; answers.value = {}; error.value = ''; void load(); }, { immediate: true });
const unsubscribe = onMessageFromExtension((message: any) => {
  const event = message.type === 'subagentMonitor.event' ? message.data?.event : undefined;
  if (event?.runId === props.runId && /^(approval_|question_|run_)/.test(event.type)) void load();
});
onBeforeUnmount(() => { requestSequence++; unsubscribe(); });
</script>
<template>
  <section v-if="approvals.length || questions.length || error" class="subagent-requests">
    <article v-for="approval in approvals" :key="approval.id"><header><strong>待确认操作 · {{ approval.toolName }}</strong></header>
      <pre>{{ approval.reason || JSON.stringify(approval.args, null, 2) }}</pre>
      <footer v-if="approval.choices?.length"><button v-for="choice in approval.choices" :key="choice.id" :disabled="!!busy"
        @click="submit(approval.id, choice.kind.startsWith('allow'), choice.id)">{{ choice.label }}</button></footer>
      <footer v-else><button :disabled="!!busy" @click="submit(approval.id, false)">拒绝</button><button class="primary" :disabled="!!busy" @click="submit(approval.id, true)">允许执行</button></footer>
    </article>
    <article v-for="request in questions" :key="request.id"><strong>子 agent 的问题</strong>
      <label v-for="(question,index) in request.questions" :key="index"><span>{{ question.title }}</span>
        <div v-if="question.options?.length" class="answer-options"><button v-for="option in question.options" :key="option" :class="{ selected: answers[request.id]?.[index] === option }" @click="answers[request.id][index] = option">{{ option }}</button></div>
        <input v-model="answers[request.id][index]" placeholder="输入回答，也可以补充说明" :aria-label="question.title" />
      </label><footer><button class="primary" :disabled="!!busy" @click="submit(request.id)">提交回答</button></footer>
    </article>
    <p v-if="error" class="request-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.subagent-requests{margin:12px 0 18px}.subagent-requests article{border:1px solid var(--gc-border-control);padding:14px;margin-top:10px;background:var(--gc-surface-panel)}strong{font-size:13px}pre{max-height:200px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:12px 0}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}label{display:grid;gap:9px;margin-top:15px;font-size:13px}input,button{font:inherit;color:var(--gc-text-primary);background:var(--gc-surface-base);border:1px solid var(--gc-border-control);border-radius:0;padding:8px 10px}button{cursor:pointer}.primary,.answer-options .selected{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.answer-options{display:flex;flex-wrap:wrap;gap:6px}.request-error{font-size:12px;color:var(--gc-danger)}
</style>
