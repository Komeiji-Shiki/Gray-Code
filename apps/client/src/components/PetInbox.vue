<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ApprovalRequest, QuestionRequest, RunRecord } from '@graycode/contracts';
import { call, subscribe } from '../api';
const props = defineProps<{ conversationId?: string }>();
const emit = defineEmits<{ open: [conversationId: string] }>();
type Inbox = { selectedConversationId?: string; conversations: { id: string; title: string }[]; selection?: { configId?: string; modelId?: string }; providers: { id: string; name: string; model: string; models: { id: string; name?: string }[] }[]; history: { id?: string; role: string; text: string }[]; runs: (RunRecord & { title: string })[]; approvals: ApprovalRequest[]; questions: QuestionRequest[] };
const inbox = ref<Inbox>(), selected = ref(props.conversationId || localStorage.getItem('graycode.petConversation') || ''), providerId = ref(''), modelId = ref(''), text = ref(''), error = ref(''), busy = ref(false), notice = ref('');
const answers = reactive<Record<string, string[]>>({});
const drafts = new Map<string, string>();
function persistDraft(id: string, value: string) { if (!id) return; try { if (value) localStorage.setItem(`graycode.petDraft:${id}`, value); else localStorage.removeItem(`graycode.petDraft:${id}`); } catch { error.value = '当前浏览器无法保存桌宠草稿，请先保留输入文字。'; } }
const provider = computed(() => inbox.value?.providers.find(item => item.id === providerId.value));
let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, sequence = 0, streamId: string | undefined;
const title = (runId: string) => inbox.value?.runs.find(run => run.id === runId)?.title ?? runId;
const status: Record<string, string> = { queued: '排队中', running: '进行中', awaiting_approval: '等待审批', awaiting_input: '等待回答', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
async function reload() {
  const request = ++sequence;
  try {
    const result = await call<Inbox>('pets.inbox', { conversationId: selected.value || undefined });
    if (request !== sequence) return; inbox.value = result;
    if (selected.value && !result.selectedConversationId) { selected.value = ''; notice.value = '原对话已不可用，请重新选择；输入草稿保留在原对话下。'; }
    if (result.selectedConversationId === selected.value && !drafts.has(selected.value)) { const draft = localStorage.getItem(`graycode.petDraft:${selected.value}`) ?? ''; drafts.set(selected.value, draft); if (!text.value) text.value = draft; }
    if (!providerId.value && result.selection?.configId) { providerId.value = result.selection.configId; modelId.value = result.selection.modelId ?? ''; }
    for (const question of result.questions) answers[question.id] ??= question.questions.map(() => '');
  } catch (cause) { if (request === sequence) error.value = (cause as Error).message; }
}
async function perform(work: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await work(); await reload(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; } }
async function create() { const result = await call<{ id: string }>('pets.chat.create'); selected.value = result.id; }
async function send() {
  const submitted = text.value; const conversationId = selected.value; streamId ??= crypto.randomUUID();
  await call('pets.chat.send', { conversationId, configId: providerId.value, modelOverride: modelId.value || undefined, message: submitted, streamId });
  if (selected.value === conversationId && text.value === submitted) text.value = ''; persistDraft(conversationId, ''); drafts.delete(conversationId); streamId = undefined; notice.value = '消息已交给当前对话。';
}
watch(text, value => { if (inbox.value?.selectedConversationId === selected.value) persistDraft(selected.value, value); });
watch(selected, (value, previous) => { drafts.set(previous, text.value); persistDraft(previous, text.value); text.value = drafts.get(value) ?? ''; providerId.value = ''; modelId.value = ''; streamId = undefined; localStorage.setItem('graycode.petConversation', value); void reload(); });
watch(() => props.conversationId, value => { if (value && !text.value && inbox.value?.conversations.some(item => item.id === value)) selected.value = value; });
onMounted(() => {
  void reload(); unsubscribe = subscribe(event => { if (event.type === 'transport.resumed' || event.type === 'event' && /^(run\.|approval\.|question\.|message\.saved)/.test(event.event?.type ?? '')) {
    if (!timer) timer = setTimeout(() => { timer = undefined; void reload(); }, 160);
  } });
});
onBeforeUnmount(() => { persistDraft(selected.value, text.value); unsubscribe?.(); clearTimeout(timer); sequence++; });
</script>
<template><section class="pet-inbox" aria-label="桌宠交流与任务"><p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  <label>交流对象<select v-model="selected" :disabled="busy"><option value="">选择普通对话</option><option v-for="conversation in inbox?.conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title }}</option></select></label><div class="row"><button :disabled="busy" @click="perform(create)">新建陪伴对话</button><button v-if="selected" @click="emit('open', selected)">打开完整对话</button></div>
  <div v-if="selected" class="history" aria-live="polite"><article v-for="(message,index) in inbox?.history" :key="message.id || index"><strong>{{ message.role === 'model' ? '回复' : '你' }}</strong><p>{{ message.text }}</p></article></div>
  <form @submit.prevent="perform(send)"><div class="row"><label>渠道<select v-model="providerId" :disabled="busy" @change="modelId = ''"><option value="">请选择</option><option v-for="provider in inbox?.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label><label>模型<select v-model="modelId" :disabled="busy"><option value="">{{ provider?.model || '渠道默认模型' }}</option><option v-for="model in provider?.models" :key="model.id" :value="model.id">{{ model.name || model.id }}</option></select></label></div><textarea v-model="text" rows="3" aria-label="给桌宠发送消息" placeholder="想聊些什么？" :disabled="busy" /><button class="primary" :disabled="busy || !selected || !providerId || !text.trim()">{{ busy ? '正在处理…' : '发送' }}</button></form>
  <section v-if="inbox?.approvals.length || inbox?.questions.length" class="pending"><h3>需要你的处理</h3><article v-for="approval in inbox?.approvals" :key="approval.id"><strong>{{ title(approval.runId) }}</strong><p>工具审批：{{ approval.toolName }}</p><details><summary>查看具体操作</summary><pre>{{ JSON.stringify(approval.args, null, 2) }}</pre><p>{{ approval.effects.join(' / ') }}</p></details><div class="row"><button :disabled="busy" @click="perform(async () => { await call('approvals.resolve', { id: approval.id, accepted: false }); })">拒绝这次操作</button><button :disabled="busy" @click="perform(async () => { await call('approvals.resolve', { id: approval.id, accepted: true }); })">允许这次操作</button></div></article><article v-for="question in inbox?.questions" :key="question.id"><strong>{{ title(question.runId) }}</strong><label v-for="(item,index) in question.questions" :key="index">{{ item.title }}<select v-if="item.options?.length" v-model="answers[question.id]![index]"><option value="">选择建议或填写下方回答</option><option v-for="option in item.options" :key="option" :value="option">{{ option }}</option></select><input v-model="answers[question.id]![index]" placeholder="你的回答"></label><button :disabled="busy || !answers[question.id]?.every(value => value.trim())" @click="perform(async () => { await call('questions.answer', { id: question.id, answers: answers[question.id] }); })">提交这组回答</button></article></section>
  <details class="tasks"><summary>最近任务 · {{ inbox?.runs.length ?? 0 }}</summary><article v-for="run in inbox?.runs" :key="run.id"><div><strong>{{ run.title }}</strong><span>{{ status[run.status] }}</span></div><small>{{ new Date(run.createdAt).toLocaleString() }} · {{ run.id.slice(0,8) }}</small><p v-if="run.error">{{ run.error }}</p><button @click="emit('open', run.conversationId)">查看这项任务</button></article></details>
</section></template>
<style scoped>.pet-inbox{padding:14px;color:var(--text);background:var(--background);border:1px solid var(--border);font-size:12px;overflow:auto;max-height:50dvh;box-sizing:border-box}.pet-inbox label{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;margin:8px 0}.row{display:flex;gap:8px;flex-wrap:wrap}.row>label{min-width:100px}button,input,select,textarea{border:1px solid var(--border);border-radius:0;color:var(--text);background:var(--surface);padding:6px 8px;font:inherit;min-width:0}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}textarea{resize:vertical;width:100%;box-sizing:border-box;margin-top:8px}.primary{background:var(--accent);color:#111820;margin:8px 0}.history{max-height:170px;overflow:auto;margin:12px 0;border-block:1px solid var(--border)}article{margin:10px 0;padding:10px 0;border-bottom:1px solid var(--border)}article p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:6px 0}article strong{font-size:12px}.tasks article>div{display:flex;justify-content:space-between;gap:8px}small,.tasks span{font-size:11px;color:var(--muted)}.tasks button{margin-top:6px}.pending h3{font-size:13px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 monospace}.error{color:#eda0a0}</style>
