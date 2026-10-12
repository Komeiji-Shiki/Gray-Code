<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { PetInbox } from '@graycode/contracts';
import { call, rpc, subscribe } from '../api';
import { shellLocale, shellText } from '../i18n';
import ApprovalButtons from './ApprovalButtons.vue';

const props = defineProps<{ conversationId?: string }>();
const emit = defineEmits<{ open: [conversationId: string] }>();
const inbox = ref<PetInbox>();
const selected = ref(props.conversationId || localStorage.getItem('graycode.petConversation') || '');
const providerId = ref('');
const modelId = ref('');
const text = ref('');
const error = ref('');
const busy = ref(false);
const notice = ref('');
const answers = reactive<Record<string, string[]>>({});
const drafts = new Map<string, string>();
const provider = computed(() => inbox.value?.providers.find(item => item.id === providerId.value));
const title = (runId: string) => inbox.value?.runs.find(run => run.id === runId)?.title ?? runId;
const status = computed<Record<string, string>>(() => ({
  queued: shellText('petRunQueued'),
  running: shellText('petRunRunning'),
  awaiting_approval: shellText('petRunApproval'),
  awaiting_input: shellText('petRunInput'),
  completed: shellText('petRunCompleted'),
  failed: shellText('petRunFailed'),
  cancelled: shellText('petRunCancelled'),
  interrupted: shellText('petRunInterrupted'),
}));
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
let streamId: string | undefined;

function persistDraft(id: string, value: string) {
  if (!id) return;
  try {
    if (value) localStorage.setItem('graycode.petDraft:' + id, value);
    else localStorage.removeItem('graycode.petDraft:' + id);
  } catch {
    error.value = shellText('petInboxDraftUnavailable');
  }
}

async function reload() {
  const request = ++sequence;
  try {
    const result = await rpc('pets.inbox', { conversationId: selected.value || undefined });
    if (request !== sequence) return;
    inbox.value = result;
    if (selected.value && !result.selectedConversationId) {
      selected.value = '';
      notice.value = shellText('petInboxConversationUnavailable');
    }
    if (result.selectedConversationId === selected.value && !drafts.has(selected.value)) {
      const draft = localStorage.getItem('graycode.petDraft:' + selected.value) ?? '';
      drafts.set(selected.value, draft);
      if (!text.value) text.value = draft;
    }
    if (!providerId.value && result.selection?.configId) {
      providerId.value = result.selection.configId;
      modelId.value = result.selection.modelId ?? '';
    }
    for (const question of result.questions) answers[question.id] ??= question.questions.map(() => '');
  } catch (cause) {
    if (request === sequence) error.value = (cause as Error).message;
  }
}

async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
    await reload();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function create() {
  const result = await rpc('pets.chat.create', {});
  selected.value = result.id;
}

async function send() {
  const submitted = text.value;
  const conversationId = selected.value;
  streamId ??= crypto.randomUUID();
  await rpc('pets.chat.send', {
    conversationId, configId: providerId.value, modelOverride: modelId.value || undefined,
    message: submitted, streamId,
  });
  if (selected.value === conversationId && text.value === submitted) text.value = '';
  persistDraft(conversationId, '');
  drafts.delete(conversationId);
  streamId = undefined;
  notice.value = shellText('petInboxSent');
}

watch(text, value => {
  if (inbox.value?.selectedConversationId === selected.value) persistDraft(selected.value, value);
});
watch(selected, (value, previous) => {
  drafts.set(previous, text.value);
  persistDraft(previous, text.value);
  text.value = drafts.get(value) ?? '';
  providerId.value = '';
  modelId.value = '';
  streamId = undefined;
  localStorage.setItem('graycode.petConversation', value);
  void reload();
});
watch(() => props.conversationId, value => {
  if (value && !text.value && inbox.value?.conversations.some(item => item.id === value)) selected.value = value;
});
onMounted(() => {
  void reload();
  unsubscribe = subscribe(event => {
    if (event.type === 'transport.resumed'
      || event.type === 'event' && /^(run\.|approval\.|question\.|message\.saved)/.test(event.event?.type ?? '')) {
      if (!timer) timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, 160);
    }
  });
});
onBeforeUnmount(() => {
  persistDraft(selected.value, text.value);
  unsubscribe?.();
  clearTimeout(timer);
  sequence++;
});
</script>

<template>
  <section class="pet-inbox" :aria-label="shellText('petInboxLabel')">
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <label>
      {{ shellText('petInboxTarget') }}
      <select v-model="selected" :disabled="busy">
        <option value="">{{ shellText('petInboxChooseConversation') }}</option>
        <option v-for="conversation in inbox?.conversations" :key="conversation.id" :value="conversation.id">
          {{ conversation.title }}
        </option>
      </select>
    </label>
    <div class="row">
      <button :disabled="busy" @click="perform(create)">{{ shellText('petInboxCreate') }}</button>
      <button v-if="selected" @click="emit('open', selected)">{{ shellText('petInboxOpen') }}</button>
    </div>
    <div v-if="selected" class="history" aria-live="polite">
      <article v-for="(message, index) in inbox?.history" :key="message.id || index">
        <strong>{{ shellText(message.role === 'model' ? 'petInboxReply' : 'petInboxYou') }}</strong>
        <p>{{ message.text }}</p>
      </article>
    </div>
    <form @submit.prevent="perform(send)">
      <div class="row">
        <label>
          {{ shellText('petInboxProvider') }}
          <select v-model="providerId" :disabled="busy" @change="modelId = ''">
            <option value="">{{ shellText('petChoose') }}</option>
            <option v-for="item in inbox?.providers" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label>
          {{ shellText('petInboxModel') }}
          <select v-model="modelId" :disabled="busy">
            <option value="">{{ provider?.model || shellText('petInboxDefaultModel') }}</option>
            <option v-for="model in provider?.models" :key="model.id" :value="model.id">{{ model.name || model.id }}</option>
          </select>
        </label>
      </div>
      <textarea v-model="text" rows="3" :aria-label="shellText('petInboxMessage')"
        :placeholder="shellText('petInboxMessageHint')" :disabled="busy" />
      <button class="primary" :disabled="busy || !selected || !providerId || !text.trim()">
        {{ shellText(busy ? 'petInboxBusy' : 'petInboxSend') }}
      </button>
    </form>
    <section v-if="inbox?.approvals.length || inbox?.questions.length" class="pending">
      <h3>{{ shellText('petInboxPending') }}</h3>
      <article v-for="approval in inbox?.approvals" :key="approval.id">
        <strong>{{ title(approval.runId) }}</strong>
        <p>{{ shellText('petInboxApproval', { tool: approval.toolName }) }}</p>
        <details>
          <summary>{{ shellText('petInboxDetails') }}</summary>
          <pre>{{ JSON.stringify(approval.args, null, 2) }}</pre>
          <p>{{ approval.effects.join(' / ') }}</p>
        </details>
        <p v-if="approval.reason">{{ approval.reason }}</p>
        <ApprovalButtons :choices="approval.choices" :disabled="busy"
          :allow-label="shellText('petInboxAllow')" :deny-label="shellText('petInboxDeny')"
          @resolve="decision => perform(async () => { await rpc('approvals.resolve', { id: approval.id, ...decision }); })" />
      </article>
      <article v-for="question in inbox?.questions" :key="question.id">
        <strong>{{ title(question.runId) }}</strong>
        <label v-for="(item, index) in question.questions" :key="index">
          {{ item.title }}
          <select v-if="item.options?.length" v-model="answers[question.id]![index]">
            <option value="">{{ shellText('petInboxChooseAnswer') }}</option>
            <option v-for="option in item.options" :key="option" :value="option">{{ option }}</option>
          </select>
          <input v-model="answers[question.id]![index]" :placeholder="shellText('petInboxAnswer')">
        </label>
        <button :disabled="busy || !answers[question.id]?.every(value => value.trim())"
          @click="perform(async () => { await call('questions.answer', { id: question.id, answers: answers[question.id] }); })">
          {{ shellText('petInboxSubmitAnswers') }}
        </button>
      </article>
    </section>
    <details class="tasks">
      <summary>{{ shellText('petInboxRecent', { count: inbox?.runs.length ?? 0 }) }}</summary>
      <article v-for="run in inbox?.runs" :key="run.id">
        <div><strong>{{ run.title }}</strong><span>{{ status[run.status] }}</span></div>
        <small>{{ new Date(run.createdAt).toLocaleString(shellLocale) }} · {{ run.id.slice(0, 8) }}</small>
        <p v-if="run.error">{{ run.error }}</p>
        <button @click="emit('open', run.conversationId)">{{ shellText('petInboxViewTask') }}</button>
      </article>
    </details>
  </section>
</template>

<style scoped>
.pet-inbox {
  padding: 14px;
  color: var(--gc-text-primary);
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  font-size: 12px;
  overflow: auto;
  max-height: 50dvh;
  box-sizing: border-box;
}
.pet-inbox label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
  margin: 8px 0;
}
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.row > label { min-width: 100px; }
button, input, select, textarea {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  color: var(--gc-text-primary);
  background: var(--gc-surface-sunken);
  padding: 6px 8px;
  font: inherit;
  min-width: 0;
}
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
textarea { resize: vertical; width: 100%; box-sizing: border-box; margin-top: 8px; }
.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); margin: 8px 0; }
.history { max-height: 170px; overflow: auto; margin: 12px 0; border-block: 1px solid var(--gc-border-subtle); }
article { margin: 10px 0; padding: 10px 0; border-bottom: 1px solid var(--gc-border-subtle); }
article p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; margin: 6px 0; }
article strong { font-size: 12px; }
.tasks article > div { display: flex; justify-content: space-between; gap: 8px; }
small, .tasks span { font-size: 11px; color: var(--gc-text-muted); }
.tasks button { margin-top: 6px; }
.pending h3 { font-size: 13px; }
summary { cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.6 monospace; }
.error { color: var(--gc-danger); }
</style>
