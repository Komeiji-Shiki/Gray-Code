<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import PlatformWorkspaceSettings from './PlatformWorkspaceSettings.vue';
import BotProfileFields from './bots/BotProfileFields.vue';
import BotOutputFields from './bots/BotOutputFields.vue';
import BotOutboxPanel from './bots/BotOutboxPanel.vue';
import BotMessagePolicyFields from './bots/BotMessagePolicyFields.vue';
import BotTriggerFields from './bots/BotTriggerFields.vue';
import BotDiagnosticsPanel from './bots/BotDiagnosticsPanel.vue';
import { DEFAULT_BOT_MESSAGE_POLICY, DEFAULT_ONEBOT_OUTPUT, DEFAULT_QQ_BOT_ENVIRONMENT } from '../../../../shared/botConversation';
import PermissionAccountFields from './PermissionAccountFields.vue';
import type { AppSettings, BotOutputSettings, DiscordReplyProfile, PlatformBinding, OneBotSettings } from '../../../../packages/contracts/src/settings';
import type { CharacterResource } from '../../../../packages/contracts/src/characters';
import type { ActorIdentity } from '../../../../packages/contracts/src/runtime';
import { sendToExtension } from '../../utils/vscode';
import { useDesktopSettingsDraft, desktopSettingsDraft, markDesktopSettingsDirty } from '../../platform/settingsDraft';
import { useBotConnectionStatus } from '../../composables/useBotConnectionStatus';
const props = defineProps<{ section: 'discord' | 'onebot' | 'accounts' | 'workspaces' }>();
const settings = ref<AppSettings>();
const platform = computed(() => props.section === 'onebot' ? 'onebot' : 'discord');
const bot = computed(() => settings.value?.[platform.value]);
const credentialChanges = ref<Record<string, string | null>>({});
const { status, statusLabel, refreshStatus, startConnection } = useBotConnectionStatus(platform);
const error = ref('');
const busy = ref(false);
const showOutbox = ref(false);
const id = (prefix: string) => prefix + '_' + crypto.randomUUID().slice(0, 8);
const pendingDeleteId = ref('');
const accountBusy = ref('');
const botChannel = ref('');
const modes = ref<Array<{ id: string; name: string }>>([]);
const resources = ref<Pick<CharacterResource, 'id' | 'name' | 'kind'>[]>([]);
const onebotOutput = computed(() => settings.value?.onebot?.output ?? { ...DEFAULT_ONEBOT_OUTPUT });
const selectedOnebotChannel = computed(() => settings.value?.onebot?.channels?.[botChannel.value] ?? {});
const baseOnebotProfile = computed<DiscordReplyProfile>(() => ({
  agentId: settings.value?.onebot?.agentId, workspaceId: settings.value?.onebot?.workspaceId,
}));
const inheritedOnebotProfile = computed<DiscordReplyProfile>(() => ({ ...baseOnebotProfile.value, ...settings.value?.onebot?.defaultProfile }));
function changeOnebotChannel(value: Partial<NonNullable<OneBotSettings['channels']>[string]>) {
  if (!settings.value?.onebot || !botChannel.value) return;
  settings.value.onebot.channels = { ...settings.value.onebot.channels, [botChannel.value]: { ...selectedOnebotChannel.value, ...value } };
}
function changeOnebotOutput(value: Partial<BotOutputSettings>) {
  if (!settings.value?.onebot) return;
  // OneBot 不支持编辑流式回复，输出配置始终保留关闭。
  settings.value.onebot.output = { ...onebotOutput.value, ...value, streaming: false };
}
const mcpPermissionTools = ref<Array<{ name: string; description?: string; serverName?: string }>>([]);
const defaultPermissionAccount = computed(() => settings.value?.accounts.find(account => account.id === settings.value?.botGuestAccountId && account.role !== 'owner'));
async function addBinding(bindingPlatform: 'discord' | 'onebot' = platform.value) {
  if (!settings.value) return;
  const binding: PlatformBinding = { id: id('binding'), platform: bindingPlatform, platformUserId: '', accountId: '',
    ...(bindingPlatform === 'onebot' ? { network: settings.value.onebot?.protocolVersion === 12 ? settings.value.onebot.self?.platform : 'qq' } : {}) };
  settings.value.bindings.push(binding);
  markDesktopSettingsDirty();
  await nextTick();
  document.getElementById(`binding-user-${binding.id}`)?.focus();
}
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
function changed(event: Event) {
  if (event.target instanceof Element && event.target.closest('[data-preference-transient]')) return;
  void action(save);
}
async function connect() {
  if (desktopSettingsDraft.dirty || (await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) throw new Error('请先点击下方“保存全部”，再连接 Bot。');
  busy.value = true;
  try { await startConnection(); }
  finally { busy.value = false; }
}
async function disconnect() {
  busy.value = true;
  try { await sendToExtension(`platform.${platform.value}.stop`, {}); await refreshStatus(); }
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
      settings.value!.onebot ??= { endpoint: '', enabled: false, protocolVersion: 11, self: { platform: 'qq', userId: '' }, allowedChannelIds: [], agentId: settings.value!.agents[0]?.id ?? '', mentionOnly: true,
        processingHint: true, messagePolicy: { ...DEFAULT_BOT_MESSAGE_POLICY }, defaultProfile: { output: { ...DEFAULT_ONEBOT_OUTPUT } } };
      settings.value!.onebot.self ??= { platform: 'qq', userId: '' };
      const [promptModes, characterResources] = await Promise.all([
        sendToExtension<{ modes: Array<{ id: string; name: string }> }>('getPromptModes', {}),
        sendToExtension<typeof resources.value>('characters.list', {}),
      ]);
      modes.value = promptModes.modes; resources.value = characterResources;
    }
    if (props.section === 'discord' || props.section === 'onebot') await refreshStatus(); });
});
useDesktopSettingsDraft(save, () => !!settings.value);
</script>
<template>
  <div v-if="settings" class="platform-integrations" @change="changed">
    <template v-if="section === 'onebot' && settings.onebot && bot">
      <header class="integration-header"><h4>NapCat / OneBot</h4><span class="integration-status" role="status" :class="{ connected: status.status === 'connected' }">{{ statusLabel }}</span></header>
      <p>Bot 与桌面共用会话、模型和权限。设置通过下方“保存全部”生效，连接按钮使用已保存的设置。</p>
      <label>协议版本<select v-model.number="settings.onebot.protocolVersion"><option :value="11">OneBot 11（NapCat）</option><option :value="12">OneBot 12</option></select></label>
      <label>WebSocket 地址<input v-model="settings.onebot.endpoint" placeholder="ws://127.0.0.1:端口/" /></label>
      <template v-if="settings.onebot.protocolVersion === 12 && settings.onebot.self"><label>机器人平台标识<input v-model="settings.onebot.self.platform" placeholder="例如 qq" /></label><label>机器人用户 ID<input v-model="settings.onebot.self.userId" /></label></template>
      <p>NapCat 当前使用 OneBot 11。连接它提供的正向 WebSocket 服务；只有对端明确支持 v12 时才选择 OneBot 12。</p>
      <label>启用 Bot<input v-model="bot.enabled" type="checkbox" /></label>
      <label>启动时自动连接<input type="checkbox" :checked="bot.autoConnect !== false" @change="bot.autoConnect = ($event.target as HTMLInputElement).checked" /></label>
      <p>已启用的 Bot 在下次启动 GrayCode 时连接；关闭此项后可手动连接。</p>
      <label>开始处理时提示<input v-model="bot.processingHint" type="checkbox" /></label>
      <p>任务开始时，群聊给触发消息贴 OK 表情，私聊显示“对方正在输入”。两项均为 NapCat 扩展，对端不支持时自动跳过。</p>
      <label>访问令牌<input type="password" autocomplete="new-password" :placeholder="bot.credentialRef ? '已配置；留空保留原值' : '输入访问令牌'" @input="setToken(($event.target as HTMLInputElement).value)" /></label>
      <button v-if="bot.credentialRef" @click="delete bot.credentialRef; delete credentialChanges.onebot; action(save)">取消使用访问令牌</button>
      <div v-if="status.botId" class="integration-identity"><strong>{{ status.name || '机器人账号' }}</strong><span>{{ status.botId }}</span></div>
      <div class="connection-actions"><button :disabled="busy" @click="action(connect)">{{ busy && status.status === 'connecting' ? '正在连接…' : '连接 / 重连' }}</button><button :disabled="busy || status.status === 'stopped'" @click="action(disconnect)">断开</button><button :disabled="busy" @click="action(refreshStatus)">刷新状态</button></div>
      <p v-if="status.error || status.warning" class="integration-error" role="alert">{{ status.error || status.warning }}</p>
      <p v-if="status.retryAt">将于 {{ new Date(status.retryAt).toLocaleTimeString() }} 自动重试连接，也可以点击“连接 / 重连”。</p>
      <button class="outbox-toggle" :aria-expanded="showOutbox" @click="showOutbox = !showOutbox">{{ showOutbox ? '收起待发送消息' : '查看待发送消息' }}{{ status.pendingMessages ? `（${status.pendingMessages}）` : '' }}</button>
      <BotOutboxPanel v-if="showOutbox" :platform="platform" :connected="status.status === 'connected'" @refresh-status="action(refreshStatus)" />
      <BotDiagnosticsPanel :platform="platform" />
      <h3>默认回复配置</h3>
      <p>群聊与私聊继承这些设置，可以在下方按会话分别覆盖。会话中主动选择的模型会保留，直到切回默认配置。</p>
      <BotTriggerFields :model-value="{ trigger: bot.defaultTrigger }" :inherited="bot.mentionOnly ? 'mention' : 'all'" @update:model-value="bot.defaultTrigger = $event.trigger" />
      <p>已允许会话中的未触发消息同样记录上下文。只合并相邻同一人、间隔不超过五分钟的未 @ 消息。</p>
      <BotMessagePolicyFields :model-value="bot.messagePolicy" @update:model-value="bot.messagePolicy = $event" />
      <BotProfileFields :model-value="bot.defaultProfile ?? {}" :inherited="baseOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
        :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
        @update:model-value="bot.defaultProfile = $event" />
      <h5>默认输出方式</h5>
      <BotOutputFields :model-value="onebotOutput" :inherited="DEFAULT_ONEBOT_OUTPUT" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" @update:model-value="changeOnebotOutput" />
      <h5>私聊默认配置</h5>
      <p>没有单独配置的私聊会话继承这里。私聊仍需把 private:用户ID 加入下面允许响应的会话；单独配置的私聊优先于这里。</p>
      <BotProfileFields :model-value="bot.directMessages?.profile ?? {}" :inherited="inheritedOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
        :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
        @update:model-value="bot.directMessages = { profile: $event }" />
      <h3>允许响应的会话</h3>
      <label>允许响应的会话<textarea :value="bot.allowedChannelIds.join('\n')" rows="3" placeholder="每行一个：group:群号 或 private:用户ID" @input="bot.allowedChannelIds = ($event.target as HTMLTextAreaElement).value.split(/[\n,，]/).map(id => id.trim()).filter(Boolean)"></textarea></label>
      <p v-if="settings.onebot.protocolVersion === 12">v12 还支持 channel:群组ID:频道ID；ID 中的冒号等分隔符须作 URL 编码。</p>
      <label>单独配置群聊或私聊<select v-model="botChannel"><option value="">请选择会话</option><option v-for="channel in bot.allowedChannelIds" :key="channel" :value="channel">{{ channel }}</option></select></label>
      <div v-if="botChannel" class="integration-entry">
        <h5>{{ botChannel }}</h5>
        <BotTriggerFields v-if="!botChannel.startsWith('private:')" :model-value="selectedOnebotChannel" :inherited="bot.defaultTrigger ?? (bot.mentionOnly ? 'mention' : 'all')" override @update:model-value="changeOnebotChannel($event)" />
        <BotMessagePolicyFields v-if="!botChannel.startsWith('private:')" :model-value="selectedOnebotChannel.messagePolicy" :inherited="bot.messagePolicy" override @update:model-value="changeOnebotChannel({ messagePolicy: $event })" />
        <BotProfileFields :key="botChannel" :model-value="selectedOnebotChannel.profile ?? {}" :inherited="inheritedOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
          :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
          @update:model-value="changeOnebotChannel({ profile: $event })" />
      </div>
      <h3>平台身份绑定</h3>
      <div v-for="binding in settings.bindings.filter(item => item.platform === platform)" :key="binding.id" class="integration-entry">
        <label>平台标识<input v-model="binding.network" placeholder="qq" /></label>
        <label>平台用户 ID<input :id="`binding-user-${binding.id}`" v-model="binding.platformUserId" /></label>
        <label>权限账号<select v-model="binding.accountId"><option value="">使用未绑定用户的默认权限</option><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role }}</option></select></label>
        <label>拉黑此用户<input v-model="binding.blocked" type="checkbox" /></label>
        <button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除绑定</button>
      </div>
      <button @click="addBinding()">添加绑定</button>
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
          <label>平台用户 ID<input :id="`binding-user-${binding.id}`" v-model.trim="binding.platformUserId" :inputmode="binding.platform === 'discord' ? 'numeric' : 'text'" /></label>
          <label>权限账号<select v-model="binding.accountId"><option value="">使用默认权限</option><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role === 'owner' ? '主人，完全权限' : account.role === 'guest' ? '访客' : '授权成员' }}{{ account.revoked ? '（已撤销）' : '' }}</option></select></label>
          <label>拉黑此用户<input v-model="binding.blocked" type="checkbox" /></label>
          <div class="account-actions"><button :disabled="!binding.platformUserId" @click="action(() => createPermissionAccount({ binding }))">新建独立权限</button><button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除用户规则</button></div>
        </div>
        <button @click="addBinding('discord')">添加用户规则</button>
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
h4 { font-size: 24px; margin: 0 0 12px; } h5 { font-size: 17px; margin: 24px 0 14px; } p { color: var(--gc-text-muted); line-height: 1.7; margin: 12px 0 20px; }
label { display: flex; justify-content: space-between; align-items: center; gap: 30px; padding: 16px 0; }
input,select,textarea { width: 58%; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); padding: 8px 10px; font: inherit; border-radius: var(--gc-radius-sm); }
input[type=checkbox] { width: auto; } select[multiple] { height: 120px; }
button { padding: 8px 14px; color: var(--gc-text-primary); background: var(--gc-surface-raised); border: 1px solid var(--gc-border-control); cursor: pointer; border-radius: var(--gc-radius-sm); }
.integration-entry { padding: 12px 0 24px; margin-bottom: 20px; }
.integration-header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; }
.integration-header h4 { margin-bottom: 0; }
.integration-status { padding: 6px 10px; border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-pill); color: var(--gc-text-muted); font-size: 13px; }
.integration-status.connected { color: var(--gc-success); }
.integration-identity { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 18px; overflow-wrap: anywhere; }
.integration-identity span { color: var(--gc-text-muted); }
.connection-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 24px 0; }
.integration-error { color: var(--gc-danger); overflow-wrap: anywhere; } .workspace-directory { overflow-wrap: anywhere; }
.bot-access-settings{border:1px solid transparent;padding:18px;margin:24px 0;background:var(--gc-surface-raised);border-radius:var(--gc-radius-lg)}.bot-access-settings h3{font-size:17px;margin:0 0 12px}.bot-access-settings p{font-size:13px}.default-permission-editor{padding:18px 0;margin:8px 0 24px;border-bottom:1px solid var(--gc-border-control);scroll-margin-top:20px}.bot-user-rule{padding:12px;margin-top:14px;border:1px solid var(--gc-border-control)}.bot-user-rule.blocked{border-color:var(--gc-danger)}
@media (max-width: 560px) {
  label { flex-wrap: wrap; gap: 10px; }
  input:not([type=checkbox]), select, textarea { width: 100%; min-width: 0; box-sizing: border-box; }
  .bot-access-settings { padding: 12px; }
}
</style>

<style scoped>
.account-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:18px 0}.account-actions>span{margin-right:auto;color:var(--gc-text-muted);font-size:13px}.account-actions .revoked{color:var(--gc-danger)}.danger-button{color:var(--gc-danger)}.account-delete{padding:12px;border:1px solid var(--gc-danger)}.account-delete button{margin-right:10px}
</style>
