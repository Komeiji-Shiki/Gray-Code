<script setup lang="ts">
import { computed, reactive, ref, watch, onUnmounted } from 'vue';
import type { ExecutionNodeStatus, NodeGrant, NodeListenerSettings } from '@graycode/contracts';
import { call, subscribe } from '../api';
import NodeTasks, { type NodeTaskDraft } from './NodeTasks.vue';
import NodeScreen from './NodeScreen.vue';
import './nodePane.css';

const props = defineProps<{ visible: boolean }>();
const status = ref<ExecutionNodeStatus>();
const options = ref<{ accounts: { id: string; displayName: string; role: string; workspaceIds: '*' | string[]; computer: boolean }[]; workspaces: { id: string; name: string; directory: string }[] }>();
const settings = reactive<NodeListenerSettings>({ enabled: false, name: '', host: '127.0.0.1', port: 0 });
const grant = reactive<NodeGrant>({ actorId: '', workspaceIds: [], tasks: false, computer: false });
const tab = ref<'tasks' | 'screen' | 'pair'>('tasks');
const selected = ref('');
const pairCode = ref('');
const invitation = ref<{ code: string; expiresAt: number }>();
const error = ref(''); const notice = ref(''); const busy = ref(false); const editing = ref(false);
const stopError = ref('');
const address = ref('');
const taskDrafts = reactive<Record<string, NodeTaskDraft>>({});
let pending: Promise<void> | undefined; let again = false;
const peers = computed(() => status.value?.peers.filter(value => value.direction === 'outgoing' && !value.revokedAt) ?? []);
const incoming = computed(() => status.value?.peers.filter(value => value.direction === 'incoming') ?? []);
const peer = computed(() => peers.value.find(value => value.id === selected.value));
const account = computed(() => options.value?.accounts.find(value => value.id === grant.actorId));
const workspaces = computed(() => options.value?.workspaces.filter(value => account.value?.workspaceIds === '*' || account.value?.workspaceIds.includes(value.id)) ?? []);
const stateLabel = { online: '在线', offline: '离线', connecting: '连接中', revoked: '已撤销' };
function draft(id: string) { return taskDrafts[id] ??= { text: '', workspaceId: '', agentId: '', selectedRunId: '' }; }
function refresh() {
  if (pending) { again = true; return pending; }
  pending = (async () => {
    do {
      again = false;
      const [nextStatus, nextOptions] = await Promise.all([call<ExecutionNodeStatus>('nodes.status'), call<typeof options.value>('nodes.options')]);
      status.value = nextStatus; options.value = nextOptions;
      if (!editing.value) Object.assign(settings, status.value.settings);
      if (!selected.value || !peers.value.some(value => value.id === selected.value)) selected.value = peers.value[0]?.id ?? '';
    } while (again);
  })().finally(() => { pending = undefined; }); return pending;
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = ''; notice.value = '';
  try { await action(); await refresh(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function save() { await call('nodes.configure', settings); editing.value = false; notice.value = '本机执行入口已保存。'; }
async function stopComputer() {
  const id = peer.value?.id; if (!id) return; stopError.value = '';
  try { await call('nodes.request', { peerId: id, method: 'computer.stop' }); }
  catch (cause) { stopError.value = (cause as Error).message; }
}
async function pair() {
  const result = await call<{ peerId: string }>('nodes.pair', { code: pairCode.value });
  pairCode.value = ''; selected.value = result.peerId; tab.value = 'tasks'; notice.value = '设备已配对，请选择远端项目。';
}
async function copyInvitation() {
  if (!invitation.value) return;
  await navigator.clipboard.writeText(invitation.value.code); notice.value = '配对码已复制，在连接设备的“连接另一台设备”中粘贴。';
}
watch(() => grant.actorId, () => { grant.workspaceIds = []; if (!account.value?.computer) grant.computer = false; invitation.value = undefined; });
watch(() => peer.value?.id, () => { address.value = peer.value?.address ?? ''; });
watch(() => props.visible, visible => { if (visible) void perform(async () => { await refresh(); if (!peers.value.length) tab.value = 'pair'; }); }, { immediate: true });
const off = subscribe(event => { if (props.visible && ['nodes.changed', 'settings.changed'].includes(event.type)) void refresh().catch(cause => { error.value = cause.message; }); });
onUnmounted(off);
</script>

<template>
  <section class="node-pane" aria-label="执行设备">
    <header class="node-header"><div><strong>执行设备</strong><p>把任务交给所选设备，在这里查看结果和操作画面。</p></div><button :disabled="busy" @click="perform(refresh)">刷新</button></header>
    <div class="node-tabs"><button :class="{active:tab==='tasks'}" @click="tab='tasks'">远端任务</button><button :class="{active:tab==='screen'}" @click="tab='screen'">画面与操作</button><button :class="{active:tab==='pair'}" @click="tab='pair'">配对与权限</button></div>
    <p v-if="error" class="node-error" role="alert">{{ error }}</p><p v-if="notice" class="node-notice" role="status">{{ notice }}</p>
    <div v-if="tab!=='pair'" class="node-target"><label>执行设备<select v-model="selected" aria-label="选择执行设备"><option value="" disabled>请选择已配对设备</option><option v-for="value in peers" :key="value.id" :value="value.id">{{ value.name }} · {{ stateLabel[value.state] }}</option></select></label><span v-if="peer" :class="['node-connection',peer.state]">{{ stateLabel[peer.state] }}<small v-if="peer.capabilities">{{ peer.capabilities.account.displayName }} · {{ peer.capabilities.platform }}</small></span><button v-if="tab==='screen' && peer?.capabilities?.computer" class="node-stop" :disabled="peer.state!=='online'" @click="stopComputer">立即停止电脑操作</button><p v-if="tab==='screen' && stopError" class="node-error">{{ stopError }}</p></div>
    <div v-if="tab!=='pair' && peer?.state!=='online' && peer" class="node-reconnect"><p>{{ peer.error || '执行设备尚未连接。任务会保留在原设备。' }}</p><label>设备地址<input v-model="address" aria-label="执行设备地址"></label><button :disabled="busy" @click="perform(async()=>{await call('nodes.connect',{id:peer!.id,address})})">重新连接</button></div>
    <p v-if="tab!=='pair' && !peer" class="node-empty">尚未选择执行设备。<button @click="tab='pair'">开始配对</button></p>
    <NodeTasks v-if="peer" v-show="tab==='tasks'" :key="peer.id" :peer="peer" :draft="draft(peer.id)" :visible="visible && tab==='tasks'" />
    <NodeScreen v-if="peer" v-show="tab==='screen'" :key="peer.id" :peer="peer" :visible="visible && tab==='screen'" />
    <div v-show="tab==='pair'" class="node-pairing">
      <section class="node-section"><h3>连接另一台设备</h3><p>在执行设备上启用入口并生成配对码，然后粘贴到这里。两台设备都需要运行 GrayCode。</p><label>执行设备配对码<textarea v-model="pairCode" aria-label="执行设备配对码" autocomplete="off" spellcheck="false" placeholder="graycode-node.v1.…"></textarea></label><button :disabled="busy || !pairCode.trim() || !status?.secureStorage" @click="perform(pair)">配对设备</button></section>
      <section class="node-section"><h3>允许其他设备使用本机</h3><p v-if="!status?.secureStorage" class="node-error">加密存储不可用，请从桌面端启动；命令行服务需要配置 --key-env。</p><div class="node-fields" @input="editing=true" @change="editing=true"><label>本机名称<input v-model="settings.name" aria-label="本机设备名称"></label><label>监听地址<select v-model="settings.host" aria-label="本机监听地址"><option v-for="value in status?.interfaces" :key="value.address" :value="value.address">{{ value.address }} · {{ value.internal ? '仅本机' : value.name }}</option></select></label><label>端口<input v-model.number="settings.port" type="number" min="0" max="65535" aria-label="执行入口端口"></label><label class="node-check"><input v-model="settings.enabled" type="checkbox" aria-label="启用本机执行入口">启用本机执行入口</label></div><p class="node-hint">跨设备连接请选择双方可达的局域网或 VPN 地址。首次使用可将端口设为 0，保存后会显示实际端口。</p><button :disabled="busy || !status?.secureStorage" @click="perform(save)">保存执行入口</button><p v-if="status?.listener.address" class="node-address">{{ status.listener.address }}</p><p v-if="status?.listener.error" class="node-error">{{ status.listener.error }}</p><p v-if="status?.listener.state==='disabled'" class="node-hint">本机执行入口已关闭。</p></section>
      <section class="node-section"><h3>生成一次性配对码</h3><label>远端连接使用的本机账号<select v-model="grant.actorId" aria-label="配对绑定账号"><option value="" disabled>请选择账号</option><option v-for="value in options?.accounts" :key="value.id" :value="value.id">{{ value.displayName }} · {{ value.role==='owner' ? '主人' : value.role==='member' ? '成员' : '访客' }}</option></select></label><div class="node-row"><label class="node-check"><input v-model="grant.tasks" type="checkbox" aria-label="允许远端任务">执行任务</label><label class="node-check"><input v-model="grant.computer" type="checkbox" :disabled="!account?.computer" aria-label="允许远端电脑操作">观看和操作电脑</label></div><fieldset v-if="grant.tasks" class="node-workspaces"><legend>允许使用的本机项目</legend><label v-for="value in workspaces" :key="value.id" class="node-check"><input v-model="grant.workspaceIds" type="checkbox" :value="value.id">{{ value.name }}<small>{{ value.directory }}</small></label><p v-if="!workspaces.length" class="node-hint">此账号没有可选项目，请先在主界面添加项目并授予账号权限。</p></fieldset><button :disabled="busy || !grant.actorId || (!grant.tasks && !grant.computer) || status?.listener.state!=='listening'" @click="perform(async()=>{invitation=await call('nodes.invitation',grant)})">生成配对码</button><template v-if="invitation"><label>有效至 {{ new Date(invitation.expiresAt).toLocaleTimeString() }}<textarea :value="invitation.code" aria-label="生成的配对码" readonly spellcheck="false"></textarea></label><button @click="perform(copyInvitation)">复制配对码</button></template></section>
      <section v-if="peers.length" class="node-section"><h3>本机连接的执行设备</h3><div v-for="value in peers" :key="value.id" class="node-peer-row"><div><strong>{{ value.name }}</strong><p>{{ stateLabel[value.state] }} · {{ value.address }}</p></div><button :disabled="busy" @click="perform(async()=>{await call('nodes.disconnect',{id:value.id})})">断开</button><button :disabled="busy || value.state!=='online'" @click="perform(async()=>{await call('nodes.revoke',{id:value.id});notice='执行设备已确认撤销配对。'})">撤销配对</button><button v-if="value.state!=='online'" :disabled="busy" @click="perform(async()=>{await call('nodes.revoke',{id:value.id,localOnly:true});notice='已移除本机凭据；原执行设备上的授权记录需要在该设备撤销。'})">仅移除本机连接</button></div></section>
      <section v-if="incoming.length" class="node-section"><h3>已获本机授权的设备</h3><div v-for="value in incoming" :key="value.id" class="node-peer-row"><div><strong>{{ value.name }}</strong><p>{{ stateLabel[value.state] }} · 账号 {{ options?.accounts.find(item=>item.id===value.grant?.actorId)?.displayName || value.grant?.actorId }}</p><small>{{ value.grant?.tasks ? '执行任务' : '' }} {{ value.grant?.computer ? '观看和操作电脑' : '' }}</small></div><button v-if="!value.revokedAt" :disabled="busy" @click="perform(async()=>{await call('nodes.revoke',{id:value.id});notice='已撤销该设备，并停止它发起的任务与电脑操作。'})">撤销设备</button></div></section>
      <p class="node-hint">Web 登录用于打开当前平台界面。执行设备配对用于连接另一份独立运行器，使用它保存的账号、项目和模型配置。</p>
    </div>
  </section>
</template>
