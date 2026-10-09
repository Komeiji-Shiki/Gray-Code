<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BotMessageDiagnostic, BotPermissionDiagnostic, BotStatus } from '../../../../../packages/contracts/src/bots';
import { sendToExtension } from '../../../utils/vscode';
import { t } from '../../../i18n';
const props = defineProps<{ platform: 'discord' | 'onebot' }>();
const messages = ref<BotMessageDiagnostic[]>([]);
const connection = ref<BotStatus>();
const permission = ref<BotPermissionDiagnostic>();
const userId = ref(''), channelId = ref(''), direct = ref(false), busy = ref(false), error = ref('');
const filtered = computed(() => messages.value.filter(value => (!channelId.value || value.channelId === channelId.value) && (!userId.value || value.userId === userId.value)));
async function action(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await run(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; }
}
function refresh() { return action(async () => {
  const [result, status] = await Promise.all([
    sendToExtension<{ messages: BotMessageDiagnostic[] }>(`platform.${props.platform}.diagnostics`, {}),
    sendToExtension<BotStatus>(`platform.${props.platform}.status`, {}),
  ]);
  messages.value = result.messages; connection.value = status;
}); }
function check() { return action(async () => {
  permission.value = await sendToExtension<BotPermissionDiagnostic>(`platform.${props.platform}.checkPermission`, { userId: userId.value, channelId: channelId.value, direct: direct.value });
}); }
</script>
<template>
  <details class="bot-diagnostics" data-preference-transient @toggle="($event.target as HTMLDetailsElement).open && refresh()">
    <summary>{{ t('desktop.bot.diagnostics') }}</summary>
    <p>{{ t('desktop.bot.diagnosticsHint') }}</p>
    <div class="probe">
      <label>{{ t('desktop.bot.userId') }}<input v-model.trim="userId" /></label>
      <label>{{ t('desktop.bot.channelId') }}<input v-model.trim="channelId" /></label>
      <label v-if="platform === 'discord'" class="direct"><input v-model="direct" type="checkbox" />{{ t('desktop.bot.direct') }}</label>
    </div>
    <div class="actions"><button :disabled="busy || !userId || !channelId" @click="check">{{ t('desktop.bot.checkPermission') }}</button><button :disabled="busy" @click="refresh">{{ t(busy ? 'desktop.bot.loading' : 'desktop.bot.refresh') }}</button></div>
    <p v-if="permission"><strong>{{ t(permission.allowed ? 'desktop.bot.allowed' : 'desktop.bot.denied') }}</strong> · {{ permission.reason }}<br />
      <span v-if="permission.actorName">{{ t('desktop.bot.account') }}：{{ permission.actorName }} · </span>{{ t('desktop.bot.effectiveTrigger') }}：{{ t(`desktop.bot.trigger_${permission.trigger}`) }}</p>
    <p v-if="connection?.lastHeartbeatAt">{{ t('desktop.bot.lastHeartbeat') }}：{{ new Date(connection.lastHeartbeatAt).toLocaleTimeString() }}<span v-if="connection.online === false"> · {{ t('desktop.bot.offline') }}</span></p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!filtered.length && !busy">{{ t('desktop.bot.empty') }}</p>
    <div class="messages">
      <article v-for="message in filtered" :key="message.id">
        <header><strong>{{ t(`desktop.bot.stage_${message.stage}`) }}</strong><small>{{ new Date(message.receivedAt).toLocaleTimeString() }}</small></header>
        <small>{{ message.channelId }} · {{ message.userId }}</small><p>{{ message.preview }}</p>
        <p>{{ message.reason }}</p>
        <ol><li v-for="(step, index) in message.steps" :key="index">{{ ((step.at - message.receivedAt) / 1000).toFixed(2) }}s · {{ t(`desktop.bot.stage_${step.stage}`) }}<span v-if="step.reason">：{{ step.reason }}</span></li></ol>
      </article>
    </div>
  </details>
</template>
<style scoped>
.bot-diagnostics { margin: 20px 0; padding: 16px; background: var(--gc-surface-raised); }
summary { cursor: pointer; font-weight: 600; }
p, li { line-height: 1.65; overflow-wrap: anywhere; }
p, small, li { color: var(--gc-text-muted); }
.probe { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 8px; }
.direct { flex-direction: row; align-items: center; }
.actions, header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
input, button { min-width: 0; padding: 8px; font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
.messages { max-height: 480px; overflow: auto; }
article { padding: 12px 0; border-top: 1px solid var(--gc-border-subtle); }
ol { padding-left: 24px; font-size: 12px; }
.error { color: var(--gc-danger); }
</style>
