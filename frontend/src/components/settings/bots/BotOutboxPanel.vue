<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BotDeliverySummary } from '../../../../../packages/contracts/src/bots';
import { sendToExtension } from '../../../utils/vscode';

const props = defineProps<{ platform: 'discord' | 'onebot'; connected: boolean; channels?: Record<string, { name?: string }> }>();
const emit = defineEmits<{ refreshStatus: [] }>();
const messages = ref<BotDeliverySummary[]>([]);
const acknowledged = ref<string[]>([]);
const busy = ref('');
const error = ref('');
const loaded = ref(false);
let revision = 0;
const uncertain = (item: BotDeliverySummary) => item.phase === 'unknown' || item.phase === 'sending';

async function load() {
  const request = ++revision;
  const result = await sendToExtension<{ messages: BotDeliverySummary[] }>(`platform.${props.platform}.outbox`, {});
  if (request !== revision) return;
  messages.value = result.messages; loaded.value = true;
  acknowledged.value = acknowledged.value.filter(id => result.messages.some(item => item.id === id && uncertain(item)));
  emit('refreshStatus');
}
async function action(label: string, run: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = label; error.value = '';
  try { await run(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = ''; }
}
function refresh() { return action('loading', load); }
function retry(item: BotDeliverySummary) {
  if (!props.connected || (uncertain(item) && !acknowledged.value.includes(item.id))) return;
  return action(item.id, async () => {
    await sendToExtension(`platform.${props.platform}.retryDelivery`, { id: item.id, acknowledgeDuplicateRisk: acknowledged.value.includes(item.id) });
    acknowledged.value = acknowledged.value.filter(id => id !== item.id);
    await load();
  });
}
onMounted(refresh);
watch(() => props.connected, connected => { if (connected) void refresh(); });
onBeforeUnmount(() => { revision++; });
</script>

<template>
  <section class="bot-outbox" data-preference-transient :aria-busy="!!busy">
    <header><h5>待发送消息</h5><button :disabled="!!busy" @click="refresh">{{ busy === 'loading' ? '正在刷新…' : '刷新' }}</button></header>
    <p>任务记录保存在对话中。未确认送达的消息会保留在这里，检查实际会话后可以重试。</p>
    <p v-if="!connected" class="outbox-notice">Bot 连接后可以重试发送，当前仍可查看待发送记录。</p>
    <p v-if="error" role="alert" class="outbox-error">{{ error }}</p>
    <p v-if="!loaded && busy" role="status">正在读取待发送消息…</p>
    <p v-else-if="loaded && !messages.length" class="outbox-empty">目前没有待发送消息。</p>
    <article v-for="item in messages" :key="item.id" class="outbox-delivery">
      <header><strong>{{ uncertain(item) ? '发送结果尚未确认' : item.phase === 'editing' ? '正在更新回复' : '等待发送或更新' }}</strong><small>{{ item.createdAt ? new Date(item.createdAt).toLocaleString() : '旧版消息' }}</small></header>
      <p>会话 {{ channels?.[item.channelId]?.name || item.channelId }} · {{ item.completedParts }} / {{ item.totalParts }} 段</p>
      <pre>{{ item.preview }}</pre>
      <p v-if="item.error" class="outbox-error">{{ item.error }}</p>
      <label v-if="uncertain(item)" class="outbox-confirm"><input v-model="acknowledged" type="checkbox" :value="item.id" :disabled="!!busy" />已检查会话，允许重试并接受可能重复发送</label>
      <button :disabled="!!busy || !connected || (uncertain(item) && !acknowledged.includes(item.id))" @click="retry(item)">{{ busy === item.id ? '正在重试…' : '重试发送' }}</button>
    </article>
  </section>
</template>

<style scoped>
.bot-outbox { margin-top: 20px; }
header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
h5 { margin: 0; font-size: 17px; }
p { margin: 12px 0 20px; color: var(--gc-text-muted); line-height: 1.7; overflow-wrap: anywhere; }
small { color: var(--gc-text-muted); font-size: 12px; }
button { background: var(--gc-surface-raised); color: var(--gc-text-primary); font: inherit; padding: 8px 14px; border: 1px solid var(--gc-border-control); border-radius: 0; cursor: pointer; }
button:disabled { cursor: default; opacity: .5; }
button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.outbox-notice { padding: 12px; border-left: 2px solid var(--gc-border-control); background: var(--gc-surface-raised); }
.outbox-error { color: var(--gc-danger); }
.outbox-empty { padding: 24px; text-align: center; border: 1px solid var(--gc-border-control); }
.outbox-delivery { padding: 20px 0; border-top: 1px solid var(--gc-border-control); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; background: var(--vscode-input-background); padding: 14px; font-size: 12px; line-height: 1.65; }
.outbox-confirm { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0; font-size: 13px; line-height: 1.6; }
.outbox-confirm input { flex-shrink: 0; margin: 3px 0; width: 17px; height: 17px; accent-color: var(--vscode-focusBorder); }
</style>
