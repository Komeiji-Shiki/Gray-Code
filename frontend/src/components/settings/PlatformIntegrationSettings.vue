<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import PlatformWorkspaceSettings from './PlatformWorkspaceSettings.vue';
import BotConversationFields from './discord/BotConversationFields.vue';
import PermissionAccountFields from './PermissionAccountFields.vue';
import type { AppSettings, PlatformBinding } from '../../../../packages/contracts/src/settings';
import type { ActorIdentity } from '../../../../packages/contracts/src/runtime';
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
const mcpPermissionTools = ref<Array<{ name: string; description?: string; serverName?: string }>>([]);
const defaultPermissionAccount = computed(() => settings.value?.accounts.find(account => account.id === settings.value?.botGuestAccountId && account.role !== 'owner'));
async function createPermissionAccount(options: { binding?: PlatformBinding; defaultPermission?: boolean } = {}) {
  if (!settings.value) return;
  const { binding, defaultPermission } = options;
  const previous = binding && settings.value.accounts.find(account => account.id === binding.accountId && account.role !== 'owner');
  const account: ActorIdentity = { ...(previous ? JSON.parse(JSON.stringify(previous)) : { role: 'guest', workspaceIds: [], botWorkspaceAccess: true, effects: ['public_read'], mcpTools: [] }),
    id: id('account'), displayName: defaultPermission ? '未绑定用户默认权限' : binding ? `用户 ${binding.platformUserId || '待填写'} 的权限` : '新权限账号', revoked: false };
  settings.value.accounts.push(account);
  if (binding) binding.accountId = account.id;
  if (defaultPermission) settings.value.botGuestAccountId = account.id;
  await save(); await nextTick();
  document.getElementById(defaultPermission ? 'bot-default-permissions' : `permission-${account.id}`)?.scrollIntoView({ block: 'start' });
}
async function selectDefaultPermission(value: string) {
  if (!settings.value) return;
  // 自定义入口始终可选，创建和选择账号一起写入设置草稿。
  if (value === '$custom') return createPermissionAccount({ defaultPermission: true });
  settings.value.botGuestAccountId = value || undefined;
  await save();
}
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
    if (props.section === 'accounts') mcpPermissionTools.value = (await sendToExtension<{ tools: typeof mcpPermissionTools.value }>('tools.getMcpTools', {})).tools ?? [];
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
        <label>权限账号<select v-model="binding.accountId"><option value="">使用未绑定用户的默认权限</option><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role }}</option></select></label>
        <label>拉黑此用户<input v-model="binding.blocked" type="checkbox" /></label>
        <button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除绑定</button>
      </div>
      <button @click="settings.bindings.push({ id: id('binding'), platform, platformUserId: '', accountId: '', ...(section === 'onebot' ? { network: settings.onebot?.protocolVersion === 12 ? settings.onebot.self?.platform : 'qq' } : {}) })">添加绑定</button>
      <div class="connection-actions"><span>{{ status }}</span><button :disabled="busy" @click="action(connect)">连接 / 重连</button><button @click="action(async () => { await sendToExtension(`platform.${platform}.stop`, {}); status = '已断开'; })">断开</button></div>
    </template>
    <template v-else-if="section === 'accounts'">
      <h4>账号与授权</h4><p>可以配置统一的访客权限，也可以为每位用户指定不同权限。身份由真实平台用户 ID 确认。</p>
      <section class="bot-access-settings">
        <h3>未绑定用户的默认权限</h3>
        <label>默认权限<select :value="settings.botGuestAccountId ?? ''" aria-label="未绑定用户默认权限" @change.stop="action(() => selectDefaultPermission(($event.target as HTMLSelectElement).value))">
          <option value="">不允许主动对话</option><option value="$custom">自定义默认权限…</option>
          <option v-for="account in settings.accounts.filter(item => item.role !== 'owner')" :key="account.id" :value="account.id" :disabled="account.revoked">{{ account.displayName }}{{ account.revoked ? '（已撤销）' : '' }}</option>
        </select></label>
        <p>选择“自定义默认权限”即可在这里逐项配置，也可以复用已有权限账号。保存全部后，未绑定用户在允许的频道中使用所选权限，每位用户仍独立识别。Discord 私聊继续只对主人开放。</p>
        <div v-if="defaultPermissionAccount" id="bot-default-permissions" class="default-permission-editor">
          <h3>{{ defaultPermissionAccount.displayName }}</h3>
          <p>下方修改会同步到使用“{{ defaultPermissionAccount.displayName }}”的用户。</p>
          <PermissionAccountFields :account="defaultPermissionAccount" :workspaces="settings.workspaces" :mcp-tools="mcpPermissionTools" expand-mcp @change="action(save)" />
        </div>
        <h3>指定用户与黑名单</h3>
        <p>可以复用已有权限，也可点击“新建独立权限”为此用户单独配置。拉黑优先于默认权限和账号授权。</p>
        <div v-for="binding in settings.bindings" :key="binding.id" class="integration-entry bot-user-rule" :class="{ blocked: binding.blocked }">
          <label>平台<select v-model="binding.platform"><option value="discord">Discord</option><option value="onebot">QQ / OneBot</option></select></label>
          <label v-if="binding.platform === 'onebot'">平台标识<input v-model="binding.network" placeholder="qq" /></label>
          <label>平台用户 ID<input v-model.trim="binding.platformUserId" :inputmode="binding.platform === 'discord' ? 'numeric' : 'text'" /></label>
          <label>权限账号<select v-model="binding.accountId"><option value="">使用默认权限</option><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role === 'owner' ? '主人，完全权限' : account.role === 'guest' ? '访客' : '授权成员' }}{{ account.revoked ? '（已撤销）' : '' }}</option></select></label>
          <label>拉黑此用户<input v-model="binding.blocked" type="checkbox" /></label>
          <div class="account-actions"><button :disabled="!binding.platformUserId" @click="action(() => createPermissionAccount({ binding }))">新建独立权限</button><button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除用户规则</button></div>
        </div>
        <button @click="settings.bindings.push({ id: id('binding'), platform: 'discord', platformUserId: '', accountId: '' })">添加用户规则</button>
      </section>
      <h3>权限账号</h3>
      <div v-for="account in settings.accounts" :id="`permission-${account.id}`" :key="account.id" class="integration-entry">
        <label>显示名称<input v-model="account.displayName" /></label>
        <label v-if="account.id === 'owner'">身份<select disabled><option>主人</option></select></label>
        <template v-if="account.id !== 'owner'">
          <p v-if="account.id === defaultPermissionAccount?.id">此账号的权限在上方“未绑定用户的默认权限”中配置。</p>
          <PermissionAccountFields v-else :account="account" :workspaces="settings.workspaces" :mcp-tools="mcpPermissionTools" @change="action(save)" />
          <div class="account-actions"><span :class="{ revoked: account.revoked }">{{ account.revoked ? '授权已撤销' : '账号权限随保存全部生效' }}</span><button :disabled="account.revoked || accountBusy === account.id" @click="action(() => accountAction(account.id, 'revoke'))">{{ account.revoked ? '已撤销授权' : '立即撤销授权' }}</button><button class="danger-button" :disabled="accountBusy === account.id" @click="pendingDeleteId = account.id">删除账号</button></div>
          <div v-if="pendingDeleteId === account.id" class="account-delete"><p>删除账号，保留已有对话，关联用户会保留为拉黑规则。此操作立即生效。</p><button class="danger-button" :disabled="accountBusy === account.id" @click="action(() => accountAction(account.id, 'delete'))">确认删除</button><button @click="pendingDeleteId = ''">取消</button></div>
        </template>
      </div>
      <button @click="action(() => createPermissionAccount())">添加权限账号</button>
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
.bot-access-settings{border:1px solid var(--gc-border-control);padding:18px;margin:24px 0}.bot-access-settings h3{font-size:17px;margin:0 0 12px}.bot-access-settings p{font-size:13px}.default-permission-editor{padding:18px 0;margin:8px 0 24px;border-bottom:1px solid var(--gc-border-control);scroll-margin-top:20px}.bot-user-rule{padding:12px;margin-top:14px;border:1px solid var(--gc-border-control)}.bot-user-rule.blocked{border-color:var(--gc-danger)}
</style>

<style scoped>
.account-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:18px 0}.account-actions>span{margin-right:auto;color:var(--gc-text-muted);font-size:13px}.account-actions .revoked{color:var(--gc-danger)}.danger-button{color:var(--gc-danger)}.account-delete{padding:12px;border:1px solid var(--gc-danger)}.account-delete button{margin-right:10px}
</style>
