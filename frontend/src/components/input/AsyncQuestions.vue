<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { QuestionRequest } from '../../../../packages/contracts/src/runtime';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';
const props = defineProps<{ conversationId: string | null }>();
const questions = ref<QuestionRequest[]>([]);
const answers = ref<Record<string, string[]>>({});
const error = ref('');
const submitting = ref(new Set<string>());
let refreshEpoch = 0;
let disposed = false;
async function refresh() {
  const epoch = ++refreshEpoch;
  const conversationId = props.conversationId;
  if (!conversationId) { questions.value = []; return; }
  try {
    const result = await sendToExtension<QuestionRequest[]>('platform.questions.list', { conversationId });
    if (epoch !== refreshEpoch || props.conversationId !== conversationId) return;
    questions.value = result;
    error.value = '';
    for (const item of result) answers.value[item.id] ??= item.questions.map(() => '');
  } catch (e) { if (epoch === refreshEpoch && props.conversationId === conversationId) error.value = (e as Error).message; }
}
async function answer(id: string) {
  if (submitting.value.has(id)) return;
  const conversationId = props.conversationId;
  submitting.value.add(id); error.value = '';
  try {
    await sendToExtension('platform.questions.answer', { id, answers: answers.value[id] });
    if (!disposed && props.conversationId === conversationId) await refresh();
  } catch (e) { if (!disposed && props.conversationId === conversationId) error.value = (e as Error).message; }
  finally { submitting.value.delete(id); }
}
watch(() => props.conversationId, () => {
  // 等待新会话列表期间不能继续展示或提交旧会话的问题。
  questions.value = []; error.value = '';
  void refresh();
}, { immediate: true });
const dispose = onMessageFromExtension(message => { if (message.type === 'platformQuestionsChanged') void refresh(); });
onBeforeUnmount(() => { disposed = true; refreshEpoch++; dispose(); });
</script>
<template>
  <section v-if="questions.length" class="async-questions">
    <div v-for="request in questions" :key="request.id" class="async-question">
      <strong>需要补充的信息</strong><p>不依赖回答的工作会继续。你可以选择建议答案，也可以自由填写。</p>
      <label v-for="(question, index) in request.questions" :key="index"><span>{{ question.title }}</span>
        <select v-if="question.options?.length" v-model="answers[request.id][index]"><option value="">选择建议答案…</option><option v-for="option in question.options" :key="option" :value="option">{{ option }}</option></select>
        <input v-model="answers[request.id][index]" placeholder="填写你的回答…" />
      </label>
      <button :disabled="submitting.has(request.id) || answers[request.id].some(answer => !answer.trim())"
        :aria-busy="submitting.has(request.id)" @click="answer(request.id)">提交回答</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.async-questions { padding: 12px 16px; max-height: 42vh; overflow: auto; }
.async-question { padding: 16px; border: 1px solid var(--gc-border-control); border-left: 3px solid var(--gc-accent); background: var(--gc-surface-raised); }
.async-question p { color: var(--gc-text-muted); font-size: var(--gc-font-size-body); margin: 8px 0 14px; }
label { display: grid; gap: 7px; margin-bottom: 13px; }
input, select { padding: 8px; color: var(--gc-text-primary); background: var(--vscode-input-background); border: 1px solid var(--gc-border-control); font: inherit; border-radius: 0; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 8px 14px; cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
</style>
