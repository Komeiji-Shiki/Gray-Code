<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import PlatformWorkspaceSettings from './PlatformWorkspaceSettings.vue';
import BotConversationFields from './discord/BotConversationFields.vue';
import type { AppSettings } from '../../../../packages/contracts/src/settings';
import { sendToExtension } from '../../utils/vscode';
import { useDesktopSettingsDraft } from '../../platform/settingsDraft';
const props = defineProps<{ section: 'discord' | 'onebot' | 'accounts' | 'workspaces' }>();
const settings = ref<AppSettings>();
const platform = computed(() => props.section === 'onebot' ? 'onebot' : 'discord');
const bot = computed(() => settings.value?.[platform.value]);
const credentialChanges = ref<Record<string, string | null>>({});
const status = ref('未连接');
const error = ref('');
const busy = ref(false);
const id = (prefix: string) => prefix + '_' + crypto.randomUUID().slice(0, 8);
const pendingDeleteId = ref('');
const accountBusy = ref('');
const botChannel = ref('');
const permissions = [{ id: 'public_read', label: '公开网页读取与搜索' }, { id: 'workspace_read', label: '读取工作区' }, { id: 'workspace_write', label: '修改工作区' }, { id: 'process_execute', label: '执行命令' }, { id: 'data_delete', label: '删除数据' }, { id: 'external_send', label: '向外部发送' }, { id: 'private_browser', label: '私人浏览器' }, { id: 'desktop_control', label: '操作桌面' }, { id: 'administration', label: '管理类操作' }, { id: 'high_risk', label: '高风险操作' }];
async function accountAction(accountId: string, operation: 'revoke' | 'delete') {
  accountBusy.value = accountId;
  try {
    await save();
    await sendToExtension(`platform.accounts.${operation}`, { id: accountId });
    settings.value = await sendToExtension('platform.settings.get', {});
    pendingDeleteId.value = '';
  } finally { accountBusy.value = ''; }
}
async function save() {
  if (!settings.value) return;
  await sendToExtension('platform.settings.update', { settings: settings.value, credentials: credentialChanges.value });
}
async function action(run: () => Promise<unknown>) {
  try { error.value = ''; await run(); } catch (e) { error.value = (e as Error).message; }
}
async function connect() {
  if ((await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) throw new Error('请先保存全部设置，再连接 Bot。');
  busy.value = true;
  try { status.value = '正在连接…'; const result = await sendToExtension<any>(`platform.${platform.value}.start`, {}); status.value = result.name ? `${result.name} · ${result.status}` : result.status; }
  finally { busy.value = false; }
}
function setToken(value: string) {
  if (value.trim()) { credentialChanges.value[platform.value] = value; bot.value!.credentialRef = platform.value; }
  else delete credentialChanges.value[platform.value];
}
onMounted(async () => {
  await action(async () => { settings.value = await sendToExtension('platform.settings.get', {});
    if (props.section === 'onebot') {
      settings.value!.onebot ??= { endpoint: '', enabled: false, protocolVersion: 11, self: { platform: 'qq', userId: '' }, allowedChannelIds: [], agentId: settings.value!.agents[0]?.id ?? '', mentionOnly: true };
      settings.value!.onebot.self ??= { platform: 'qq', userId: '' };
    }
    if (props.section === 'discord' || props.section === 'onebot') status.value = (await sendToExtension<any>(`platform.${platform.value}.status`, {})).status; });
});
useDesktopSettingsDraft(save, () => !!settings.value);
</script>
<template>
  <div v-if="settings" class="platform-integrations" @change="action(save)">
    <template v-if="(section === 'discord' || section === 'onebot') && bot">
      <h4>{{ section === 'onebot' ? 'NapCat / OneBot' : 'Discord Bot' }}</h4><p>Bot 与桌面共用会话、模型和权限。连接按钮使用已保存的设置。</p>
      <template v-if="section === 'onebot' && settings.onebot">
        <label>协议版本<select v-model.number="settings.onebot.protocolVersion"><option :value="11">OneBot 11（NapCat）</option><option :value="12">OneBot 12</option></select></label>
        <label>WebSocket 地址<input v-model="settings.onebot.endpoint" placeholder="ws://127.0.0.1:端口/" /></label>
        <template v-if="settings.onebot.protocolVersion === 12 && settings.onebot.self"><label>机器人平台标识<input v-model="settings.onebot.self.platform" placeholder="例如 qq" /></label><label>机器人用户 ID<input v-model="settings.onebot.self.userId" /></label></template>
        <p>NapCat 当前使用 OneBot 11。连接它提供的正向 WebSocket 服务；只有对端明确支持 v12 时才选择 OneBot 12。</p>
      </template>
      <label>启用 Bot<input v-model="bot.enabled" type="checkbox" /></label>
      <label>启动时自动连接<input type="checkbox" :checked="bot.autoConnect !== false" @change="bot.autoConnect = ($event.target as HTMLInputElement).checked" /></label>
      <p>已启用的 Bot 在下次启动 GrayCode 时连接；关闭此项后可手动连接。</p>
      <label>{{ section === 'onebot' ? '访问令牌' : 'Bot Token' }}<input type="password" autocomplete="new-password" :placeholder="bot.credentialRef ? '已配置；留空保留原值' : '输入访问令牌'" @input="setToken(($event.target as HTMLInputElement).value)" /></label>
      <button v-if="section === 'onebot' && bot.credentialRef" @click="delete bot.credentialRef; delete credentialChanges.onebot; action(save)">取消使用访问令牌</button>
      <label>允许响应的会话<textarea :value="bot.allowedChannelIds.join('\n')" rows="3" :placeholder="section === 'onebot' ? '每行一个：group:群号 或 private:用户ID' : '每行一个频道 ID'" @input="bot.allowedChannelIds = ($event.target as HTMLTextAreaElement).value.split(/[\n,，]/).map(id => id.trim()).filter(Boolean)"></textarea></label>
      <p v-if="section === 'onebot' && settings.onebot?.protocolVersion === 12">v12 还支持 channel:群组ID:频道ID；ID 中的冒号等分隔符须作 URL 编码。</p>
      <label>智能体<select v-model="bot.agentId"><option v-for="agent in settings.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
      <label>工作区<select v-model="bot.workspaceId"><option :value="undefined">各会话使用文档目录中的独立工作区</option><option v-for="workspace in settings.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label>
      <label>只响应提及 Bot 的消息<input v-model="bot.mentionOnly" type="checkbox" /></label>
      <p>已允许会话中的未触发消息同样记录上下文。只合并相邻同一人、间隔不超过五分钟的未 @ 消息。</p>
      <template v-if="section === 'onebot' && settings.onebot">
        <BotConversationFields :model-value="bot.defaultProfile ?? {}" @update:model-value="bot.defaultProfile = $event" />
        <label>单独配置群聊或私聊<select v-model="botChannel"><option value="">请选择会话</option><option v-for="channel in bot.allowedChannelIds" :key="channel" :value="channel">{{ channel }}</option></select></label>
        <BotConversationFields v-if="botChannel" :key="botChannel" :model-value="settings.onebot.channels?.[botChannel]?.profile ?? {}" :inherited="bot.defaultProfile"
          @update:model-value="settings.onebot.channels = { ...settings.onebot.channels, [botChannel]: { ...settings.onebot.channels?.[botChannel], profile: $event } }" />
      </template>
      <p v-if="section === 'discord'">关闭“只响应提及”时，需要在 Discord 开发者设置中启用 Message Content Intent。只有允许频道内、已绑定账号的消息会进入任务。</p>
      <h3>平台身份绑定</h3>
      <div v-for="binding in settings.bindings.filter(item => item.platform === platform)" :key="binding.id" class="integration-entry">
        <label v-if="section === 'onebot'">平台标识<input v-model="binding.network" placeholder="qq" /></label>
        <label>平台用户 ID<input v-model="binding.platformUserId" /></label>
        <label>本地账号<select v-model="binding.accountId"><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role }}</option></select></label>
        <button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除绑定</button>
      </div>
      <button @click="settings.bindings.push({ id: id('binding'), platform, platformUserId: '', accountId: 'owner', ...(section === 'onebot' ? { network: settings.onebot?.protocolVersion === 12 ? settings.onebot.self?.platform : 'qq' } : {}) })">添加绑定</button>
      <div class="connection-actions"><span>{{ status }}</span><button :disabled="busy" @click="action(connect)">连接 / 重连</button><button @click="action(async () => { await sendToExtension(`platform.${platform}.stop`, {}); status = '已断开'; })">断开</button></div>
    </template>
    <template v-else-if="section === 'accounts'">
      <h4>账号与授权</h4><p>身份由平台用户 ID 绑定确认。昵称、引用消息和消息正文不会改变权限。</p>
      <div v-for="account in settings.accounts" :key="account.id" class="integration-entry">
        <label>显示名称<input v-model="account.displayName" /></label>
        <label>身份<select v-model="account.role" :disabled="account.id === 'owner'"><option v-if="account.id === 'owner'" value="owner">主人</option><option value="member">授权成员</option><option value="guest">访客</option></select></label>
        <template v-if="account.id !== 'owner'">
          <div class="grant-row"><span>允许的工作区</span><div class="grant-options"><label class="grant-option"><input type="checkbox" :checked="account.workspaceIds === '*'" @change="account.workspaceIds = ($event.target as HTMLInputElement).checked ? '*' : []" /><span>全部工作区（包含以后添加的工作区）</span></label><label v-for="workspace in settings.workspaces" :key="workspace.id" class="grant-option"><input v-if="account.workspaceIds !== '*'" v-model="account.workspaceIds" type="checkbox" :value="workspace.id" /><input v-else type="checkbox" checked disabled /><span>{{ workspace.name }}</span></label><small v-if="!settings.workspaces.length">尚未添加工作区</small></div></div>
          <div class="grant-row"><span>操作权限</span><div class="grant-options"><label v-for="permission in permissions" :key="permission.id" class="grant-option" :class="{ checked: account.effects.includes(permission.id as any) }"><input v-model="account.effects" type="checkbox" :value="permission.id" /><span>{{ permission.label }}</span></label></div></div>
          <div class="account-actions"><span :class="{ revoked: account.revoked }">{{ account.revoked ? '授权已撤销' : '账号权限随保存全部生效' }}</span><button :disabled="account.revoked || accountBusy === account.id" @click="action(() => accountAction(account.id, 'revoke'))">{{ account.revoked ? '已撤销授权' : '立即撤销授权' }}</button><button class="danger-button" :disabled="accountBusy === account.id" @click="pendingDeleteId = account.id">删除账号</button></div>
          <div v-if="pendingDeleteId === account.id" class="account-delete"><p>删除账号及其平台绑定，保留已有对话记录。此操作立即生效。</p><button class="danger-button" :disabled="accountBusy === account.id" @click="action(() => accountAction(account.id, 'delete'))">确认删除</button><button @click="pendingDeleteId = ''">取消</button></div>
        </template>
      </div>
      <button @click="settings.accounts.push({ id: id('account'), displayName: '新账号', role: 'guest', workspaceIds: [], effects: ['public_read'] }); action(save)">添加账号</button>
    </template>
    <template v-else>
      <PlatformWorkspaceSettings :workspaces="settings.workspaces" @change="action(save)" @error="error = $event" />
    </template>
  </div>
  <p v-if="error" class="integration-error" role="alert">{{ error }}</p>
</template>
<style scoped>
h4 { font-size: 24px; margin: 0 0 12px; } p { color: var(--gc-text-muted); line-height: 1.7; margin: 12px 0 20px; }
label { display: flex; justify-content: space-between; align-items: center; gap: 30px; padding: 16px 0; border-bottom: 1px solid var(--gc-border-subtle); }
input,select,textarea { width: 58%; color: var(--gc-text-primary); background: var(--vscode-input-background); border: 1px solid var(--gc-border-control); padding: 8px 10px; font: inherit; border-radius: 0; }
input[type=checkbox] { width: auto; } select[multiple] { height: 120px; }
button { padding: 8px 14px; color: var(--gc-text-primary); background: var(--gc-surface-raised); border: 1px solid var(--gc-border-control); cursor: pointer; border-radius: 0; }
.integration-entry { padding: 12px 0 24px; margin-bottom: 20px; border-bottom: 1px solid var(--gc-border-control); }
.connection-actions { display: flex; gap: 12px; align-items: center; padding: 24px 0; }
.connection-actions span { flex: 1; } .integration-error { color: var(--gc-danger); } .workspace-directory { overflow-wrap: anywhere; }
</style>

<style scoped>
.grant-row{display:flex;justify-content:space-between;gap:30px;padding:16px 0;border-bottom:1px solid var(--gc-border-subtle)}.grant-row>span{padding-top:9px}.grant-options{width:58%;display:grid;gap:7px}.grant-options .grant-option{width:100%;display:flex;justify-content:flex-start;gap:12px;min-height:40px;padding:8px 12px;background:var(--vscode-input-background);border:1px solid var(--gc-border-control);cursor:pointer}.grant-options .grant-option:has(input:checked){border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 13%,var(--vscode-input-background))}.grant-option input{appearance:auto;accent-color:var(--vscode-focusBorder);width:18px;height:18px;flex-shrink:0;margin:0}.account-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:18px 0}.account-actions>span{margin-right:auto;color:var(--gc-text-muted);font-size:13px}.account-actions .revoked{color:var(--gc-danger)}.danger-button{color:var(--gc-danger)}.account-delete{padding:12px;border:1px solid var(--gc-danger)}.account-delete button{margin-right:10px}
</style>
