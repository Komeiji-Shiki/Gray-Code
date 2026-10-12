<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { QuestionRequest } from '../../../../packages/contracts/src/runtime';
import { sendToExtension, onMessageFromExtension } from '../../utils/vscode';
import { useI18n } from '../../i18n';
import { toolQuestionTitle } from '../../utils/toolPresentation';

const props = defineProps<{ conversationId: string | null }>();
const emit = defineEmits<{ 'pending-change': [pending: boolean] }>();
const { t } = useI18n();
const questions = ref<QuestionRequest[]>([]);
const answers = ref<Record<string, string[]>>({});
const selectedOptions = ref<Record<string, string[]>>({});
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
    for (const item of result) {
      answers.value[item.id] ??= item.questions.map(() => '');
      selectedOptions.value[item.id] ??= item.questions.map(() => '');
    }
  } catch (e) { if (epoch === refreshEpoch && props.conversationId === conversationId) error.value = (e as Error).message; }
}
function resolvedAnswers(request: QuestionRequest): string[] {
  return request.questions.map((_, index) => selectedOptions.value[request.id][index] || answers.value[request.id][index]);
}

function selectOption(requestId: string, index: number, option: string) {
  selectedOptions.value[requestId][index] = option;
  answers.value[requestId][index] = '';
}

function writeAnswer(requestId: string, index: number, event: Event) {
  answers.value[requestId][index] = (event.target as HTMLInputElement).value;
  selectedOptions.value[requestId][index] = '';
}

async function answer(request: QuestionRequest) {
  const id = request.id;
  if (submitting.value.has(id)) return;
  const conversationId = props.conversationId;
  submitting.value.add(id); error.value = '';
  try {
    await sendToExtension('platform.questions.answer', { id, answers: resolvedAnswers(request) });
    if (!disposed && props.conversationId === conversationId) await refresh();
  } catch (e) { if (!disposed && props.conversationId === conversationId) error.value = (e as Error).message; }
  finally { submitting.value.delete(id); }
}
watch(() => props.conversationId, () => {
  // 等待新会话列表期间不能继续展示或提交旧会话的问题。
  questions.value = []; answers.value = {}; selectedOptions.value = {}; error.value = '';
  void refresh();
}, { immediate: true });
watch(() => questions.value.length > 0, pending => emit('pending-change', pending), { immediate: true, flush: 'sync' });
const dispose = onMessageFromExtension(message => { if (message.type === 'platformQuestionsChanged') void refresh(); });
onBeforeUnmount(() => { disposed = true; refreshEpoch++; dispose(); });
</script>
<template>
  <section v-if="questions.length" class="async-questions">
    <div v-for="request in questions" :key="request.id" class="async-question">
      <strong>{{ toolQuestionTitle({ questions: request.questions }) }}</strong>
      <p>{{ t('components.input.asyncQuestions.description') }}</p>
      <fieldset
        v-for="(question, index) in request.questions"
        :key="index"
        class="question-fields"
        :aria-label="question.title"
        :disabled="submitting.has(request.id)"
      >
        <legend v-if="request.questions.length > 1">{{ question.title }}</legend>
        <div v-if="question.options?.length" class="question-options">
          <label v-for="option in question.options" :key="option" class="question-option"
            :class="{ 'is-selected': selectedOptions[request.id][index] === option }">
            <input type="radio" :name="`question-${request.id}-${index}`" :value="option"
              :checked="selectedOptions[request.id][index] === option" @change="selectOption(request.id, index, option)" />
            <span>{{ option }}</span>
          </label>
        </div>
        <input class="free-answer" :value="answers[request.id][index]" :aria-label="question.title"
          :placeholder="t('components.input.asyncQuestions.placeholder')" @input="writeAnswer(request.id, index, $event)" />
      </fieldset>
      <button class="submit-answer" :disabled="submitting.has(request.id) || resolvedAnswers(request).some(answer => !answer.trim())"
        :aria-busy="submitting.has(request.id)" @click="answer(request)">{{ t('components.input.asyncQuestions.submit') }}</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.async-questions { padding: 12px 16px; max-height: 42vh; overflow: auto; }
.async-question { padding: 16px; border: 1px solid var(--gc-border-control); border-left: 3px solid var(--gc-accent); background: var(--gc-surface-raised); }
.async-question p { color: var(--gc-text-muted); font-size: var(--gc-font-size-body); margin: 8px 0 14px; }
.question-fields { display: grid; gap: 8px; margin: 0 0 14px; padding: 0; border: 0; min-width: 0; }
.question-fields legend { margin-bottom: 8px; padding: 0; }
.question-options { display: flex; flex-wrap: wrap; gap: 8px; }
.question-option {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  cursor: pointer;
}
.question-option:hover { background: var(--gc-surface-hover); }
.question-option.is-selected { border-color: var(--gc-accent); background: var(--gc-surface-selected); }
.question-option input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.question-option:has(input:focus-visible) { outline: 1px solid var(--gc-focus-border); outline-offset: 2px; }
.question-fields:disabled .question-option { opacity: var(--gc-opacity-disabled); cursor: default; }
.free-answer {
  min-width: 0;
  padding: 8px;
  color: var(--gc-text-primary);
  background: var(--gc-surface-input);
  border: 1px solid var(--gc-border-control);
  font: inherit;
  border-radius: var(--gc-radius-sm);
}
.submit-answer { background: var(--gc-button-primary); color: var(--gc-text-on-primary); border: 0; padding: 8px 14px; cursor: pointer; }
.submit-answer:disabled { opacity: var(--gc-opacity-disabled); cursor: default; }
</style>
