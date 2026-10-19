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
const id = (prefix: string) => prefix + '_' + crypto.randomUUID().slice(0, 8);
const pendingDeleteId = ref('');
const accountBusy = ref('');
const botChannel = ref('');
// 连接、默认回复、会话覆盖各自独立成页，避免所有配置堆在一条长滚动里。
const onebotSection = ref<'connection' | 'defaults' | 'conversations' | 'direct' | 'bindings' | 'outbox'>('connection');
const onebotTabs = [
  { id: 'connection', name: '连接' }, { id: 'defaults', name: '默认回复' }, { id: 'conversations', name: '会话' },
  { id: 'direct', name: '私聊' }, { id: 'bindings', name: '身份绑定' }, { id: 'outbox', name: '待发送' },
] as const;
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
const onebotBindings = computed(() => settings.value?.bindings.filter(item => item.platform === 'onebot') ?? []);
function removeOnebotChannel(id: string) {
  if (!settings.value?.onebot) return;
  settings.value.onebot.allowedChannelIds = settings.value.onebot.allowedChannelIds.filter(item => item !== id);
  if (botChannel.value === id) botChannel.value = '';
  markDesktopSettingsDirty();
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
        processingHint: true, messagePolicy: { ...DEFAULT_BOT_MESSAGE_POLICY }, defaultProfile: {} };
      settings.value!.onebot.self ??= { platform: 'qq', userId: '' };
      // 早期版本把默认输出写进了默认回复配置，会遮住独立的“默认输出方式”；迁移到平台输出，保持实际效果不变。
      const defaultProfile = settings.value!.onebot.defaultProfile;
      if (defaultProfile?.output) {
        settings.value!.onebot.output = { ...DEFAULT_ONEBOT_OUTPUT, ...settings.value!.onebot.output, ...defaultProfile.output, streaming: false };
        const profile = { ...defaultProfile }; delete profile.output;
        settings.value!.onebot.defaultProfile = profile;
      }
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
      <header class="integration-header onebot-header">
        <div><h4>NapCat / OneBot</h4><p>让 QQ 会话使用桌面的智能体、模型与权限。修改先进入草稿，点击下方“保存全部”后生效。</p></div>
        <span class="integration-status" role="status" :class="{ connected: status.status === 'connected' }">{{ statusLabel }}</span>
      </header>
      <nav class="onebot-tabs" aria-label="OneBot 设置分类">
        <button v-for="item in onebotTabs" :key="item.id" :class="{ active: onebotSection === item.id, 'outbox-toggle': item.id === 'outbox' }"
          :aria-expanded="item.id === 'outbox' ? onebotSection === 'outbox' : undefined"
          @click="onebotSection = item.id">{{ item.name }}<span v-if="item.id === 'outbox' && status.pendingMessages"> · {{ status.pendingMessages }}</span></button>
      </nav>
      <p v-if="error" class="integration-error" role="alert">{{ error }}</p>

      <section v-if="onebotSection === 'connection'" class="onebot-section">
        <div class="onebot-card">
          <h6>连接参数</h6>
          <div class="onebot-fields">
            <label><span>协议版本</span><select v-model.number="settings.onebot.protocolVersion"><option :value="11">OneBot 11（NapCat）</option><option :value="12">OneBot 12</option></select></label>
            <label><span>WebSocket 地址<small>填写 NapCat 提供的正向 WebSocket 地址。</small></span><input v-model="settings.onebot.endpoint" placeholder="ws://127.0.0.1:端口/" /></label>
            <template v-if="settings.onebot.protocolVersion === 12 && settings.onebot.self">
              <label><span>机器人平台标识</span><input v-model="settings.onebot.self.platform" placeholder="例如 qq" /></label>
              <label><span>机器人用户 ID</span><input v-model="settings.onebot.self.userId" /></label>
            </template>
            <label>
              <span>访问令牌<small>{{ bot.credentialRef ? '已配置；留空保留原值。' : '对端未启用鉴权时可以留空。' }}</small></span>
              <div class="onebot-inline">
                <input type="password" autocomplete="new-password" :placeholder="bot.credentialRef ? '已配置；留空保留原值' : '输入访问令牌'" @input="setToken(($event.target as HTMLInputElement).value)" />
                <button v-if="bot.credentialRef" @click="delete bot.credentialRef; delete credentialChanges.onebot; action(save)">取消使用</button>
              </div>
            </label>
          </div>
          <p class="onebot-note">NapCat 当前使用 OneBot 11。只有对端明确支持 OneBot 12 时才切换协议版本。</p>
        </div>

        <div class="onebot-card">
          <h6>运行</h6>
          <div class="onebot-fields">
            <label><span>启用 Bot<small>关闭后保存设置也不会建立连接。</small></span><input v-model="bot.enabled" type="checkbox" /></label>
            <label><span>启动时自动连接<small>关闭后可在本页手动连接。</small></span><input type="checkbox" :checked="bot.autoConnect !== false" @change="bot.autoConnect = ($event.target as HTMLInputElement).checked" /></label>
            <label><span>开始处理时提示<small>群聊给触发消息贴 OK 表情，私聊显示“对方正在输入”。两项均为 NapCat 扩展，对端不支持时自动跳过。</small></span><input v-model="bot.processingHint" type="checkbox" /></label>
          </div>
          <div v-if="status.botId" class="integration-identity onebot-identity">
            <img v-if="status.avatarUrl" :src="status.avatarUrl" alt="Bot 头像" />
            <div><strong>{{ status.name || '机器人账号' }}</strong><small>{{ status.botId }}</small></div>
          </div>
          <div class="connection-actions">
            <button :disabled="busy" @click="action(connect)">{{ busy && status.status === 'connecting' ? '正在连接…' : '连接 / 重连' }}</button>
            <button :disabled="busy || status.status === 'stopped'" @click="action(disconnect)">断开</button>
            <button :disabled="busy" @click="action(refreshStatus)">刷新状态</button>
          </div>
          <p v-if="status.error || status.warning" class="integration-error" role="alert">{{ status.error || status.warning }}</p>
          <p v-if="status.retryAt" class="onebot-hint">将于 {{ new Date(status.retryAt).toLocaleTimeString() }} 自动重试连接，也可以点击“连接 / 重连”。</p>
        </div>

        <BotDiagnosticsPanel :platform="platform" />
      </section>

      <section v-else-if="onebotSection === 'defaults'" class="onebot-section">
        <h5>默认回复配置</h5>
        <p>群聊与私聊继承这些设置，可以在“会话”中分别覆盖。会话里主动选择的模型会保留，直到切回默认配置。</p>
        <div class="onebot-card">
          <h6>触发与消息合并</h6>
          <BotTriggerFields :model-value="{ trigger: bot.defaultTrigger }" :inherited="bot.mentionOnly ? 'mention' : 'all'" @update:model-value="bot.defaultTrigger = $event.trigger" />
          <BotMessagePolicyFields :model-value="bot.messagePolicy" @update:model-value="bot.messagePolicy = $event" />
        </div>
        <div class="onebot-card">
          <h6>模型、工作区与角色</h6>
          <BotProfileFields :model-value="bot.defaultProfile ?? {}" :inherited="baseOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
            :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :allow-output="false" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
            @update:model-value="bot.defaultProfile = $event" />
        </div>
        <h5>默认输出方式</h5>
        <p>OneBot 不能编辑已经发送的消息，因此逐步显示固定关闭。较长回复可以拆成多条、发送文件，或在 OneBot 11 下合并转发。</p>
        <div class="onebot-card">
          <BotOutputFields :model-value="onebotOutput" :inherited="DEFAULT_ONEBOT_OUTPUT" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" @update:model-value="changeOnebotOutput" />
        </div>
      </section>

      <section v-else-if="onebotSection === 'conversations'" class="onebot-section">
        <h5>允许响应的会话</h5>
        <p>只有列表中的群聊和私聊会触发任务。每行一个：<code>group:群号</code> 或 <code>private:用户ID</code>。</p>
        <div class="onebot-card">
          <label class="onebot-stack">
            <span>会话列表<small>留空时 Bot 保持连接，但不会响应任何消息。</small></span>
            <textarea :value="bot.allowedChannelIds.join('\n')" rows="4" placeholder="group:123456789&#10;private:10001"
              @input="bot.allowedChannelIds = ($event.target as HTMLTextAreaElement).value.split(/[\n,，]/).map(id => id.trim()).filter(Boolean)"></textarea>
          </label>
          <p v-if="settings.onebot.protocolVersion === 12" class="onebot-hint">OneBot 12 还支持 <code>channel:群组ID:频道ID</code>；ID 中的冒号等分隔符须作 URL 编码。</p>
        </div>

        <div v-if="bot.allowedChannelIds.length" class="onebot-session-list" aria-label="已允许的会话">
          <button v-for="channel in bot.allowedChannelIds" :key="channel" :class="{ active: botChannel === channel }" @click="botChannel = channel">{{ channel }}</button>
        </div>
        <p v-else class="onebot-empty">还没有允许的会话。填写上方的列表后，可以在这里单独配置每个会话。</p>

        <div v-if="botChannel" class="onebot-card onebot-session-config">
          <header class="onebot-card-header">
            <div><h6>{{ botChannel }}</h6><small>{{ botChannel.startsWith('private:') ? '私聊' : '群聊' }} · 单独配置优先于默认回复</small></div>
            <button @click="removeOnebotChannel(botChannel)">停止响应此会话</button>
          </header>
          <BotTriggerFields v-if="!botChannel.startsWith('private:')" :model-value="selectedOnebotChannel" :inherited="bot.defaultTrigger ?? (bot.mentionOnly ? 'mention' : 'all')" override @update:model-value="changeOnebotChannel($event)" />
          <BotMessagePolicyFields v-if="!botChannel.startsWith('private:')" :model-value="selectedOnebotChannel.messagePolicy" :inherited="bot.messagePolicy" override @update:model-value="changeOnebotChannel({ messagePolicy: $event })" />
          <BotProfileFields :key="botChannel" :model-value="selectedOnebotChannel.profile ?? {}" :inherited="inheritedOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
            :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
            @update:model-value="changeOnebotChannel({ profile: $event })" />
        </div>
      </section>

      <section v-else-if="onebotSection === 'direct'" class="onebot-section">
        <h5>私聊默认配置</h5>
        <p>没有单独配置的私聊会话继承这里。私聊仍需把 <code>private:用户ID</code> 加入“会话”中的允许列表；单独配置的私聊优先于这里。</p>
        <div class="onebot-card">
          <BotProfileFields :model-value="bot.directMessages?.profile ?? {}" :inherited="inheritedOnebotProfile" :settings="settings" :modes="modes" :resources="resources"
            :output="onebotOutput" :allow-streaming="false" :allow-forward="settings.onebot.protocolVersion !== 12" :default-environment="DEFAULT_QQ_BOT_ENVIRONMENT"
            @update:model-value="bot.directMessages = { profile: $event }" />
        </div>
      </section>

      <section v-else-if="onebotSection === 'bindings'" class="onebot-section">
        <h5>平台身份绑定</h5>
        <p>把 QQ 用户 ID 关联到权限账号。未绑定的用户使用“账号与授权”中的默认权限；拉黑规则优先于账号授权。</p>
        <div v-for="binding in onebotBindings" :key="binding.id" class="integration-entry onebot-binding">
          <div class="onebot-fields">
            <label><span>平台标识<small>OneBot 12 多网络时用于区分来源，留空表示 qq。</small></span><input v-model="binding.network" placeholder="qq" /></label>
            <label><span>平台用户 ID</span><input :id="`binding-user-${binding.id}`" v-model="binding.platformUserId" /></label>
            <label><span>权限账号</span><select v-model="binding.accountId"><option value="">使用未绑定用户的默认权限</option><option v-for="account in settings.accounts" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role }}</option></select></label>
            <label><span>拉黑此用户</span><input v-model="binding.blocked" type="checkbox" /></label>
          </div>
          <div class="onebot-actions">
            <button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); action(save)">移除绑定</button>
          </div>
        </div>
        <p v-if="!onebotBindings.length" class="onebot-empty">还没有绑定 QQ 用户。添加后可以在“账号与授权”里为这位用户单独配置权限。</p>
        <button @click="addBinding()">添加绑定</button>
      </section>

      <section v-else class="onebot-section">
        <BotOutboxPanel :platform="platform" :connected="status.status === 'connected'" @refresh-status="action(refreshStatus)" />
      </section>
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
  <p v-if="error && section !== 'onebot'" class="integration-error" role="alert">{{ error }}</p>
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
.connection-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 20px 0 4px; }
.integration-error { color: var(--gc-danger); overflow-wrap: anywhere; } .workspace-directory { overflow-wrap: anywhere; }
.onebot-header { align-items: flex-start; }
.onebot-header p { margin: 6px 0 0; max-width: 720px; }
.onebot-section { max-width: 1120px; }
.onebot-section h5 { margin: 26px 0 12px; }
.onebot-section h5:first-child { margin-top: 4px; }
.onebot-section code { padding: 1px 5px; background: var(--gc-surface-input); border-radius: var(--gc-radius-sm); font-size: 12px; color: var(--gc-text-primary); }
.onebot-tabs { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--gc-border-control); margin: 16px 0 24px; }
.onebot-tabs button { padding: 11px 16px; color: var(--gc-text-muted); background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; white-space: nowrap; }
.onebot-tabs button:hover { color: var(--gc-text-primary); }
.onebot-tabs button.active { color: var(--gc-focus-border); border-bottom-color: var(--gc-focus-border); }
.onebot-tabs button:focus-visible { outline: 1px solid var(--gc-focus-border); outline-offset: -2px; }
.onebot-card { padding: 2px 20px 16px; margin: 14px 0 20px; background: var(--gc-surface-raised); border: 1px solid transparent; border-radius: var(--gc-radius-lg); }
.onebot-card>h6 { margin: 16px 0 4px; font-size: 14px; font-weight: 600; }
.onebot-fields>label { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 13px 0; }
.onebot-fields>label>span { width: 42%; min-width: 0; }
.onebot-fields>label>input:not([type=checkbox]), .onebot-fields>label>select, .onebot-fields>label>textarea { width: 54%; }
.onebot-fields input, .onebot-fields select, .onebot-fields textarea { font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-input); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); padding: 9px 10px; min-width: 0; box-sizing: border-box; }
.onebot-fields input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--gc-focus-border); }
.onebot-fields small, .onebot-stack small, .onebot-card-header small { display: block; font-size: 12px; font-weight: 400; color: var(--gc-text-muted); line-height: 1.65; margin-top: 5px; }
.onebot-inline { display: flex; align-items: center; gap: 8px; width: 54%; min-width: 0; }
.onebot-fields .onebot-inline input { flex: 1; width: auto; }
.onebot-inline button { white-space: nowrap; padding: 8px 12px; }
.onebot-note { padding: 12px 14px; margin: 10px 0 4px; background: var(--gc-info-bg); border-radius: var(--gc-radius-lg); color: var(--gc-text-muted); line-height: 1.7; font-size: 13px; }
.onebot-hint { font-size: 13px; }
.onebot-stack { display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 14px 0; }
.onebot-stack textarea { width: 100%; resize: vertical; line-height: 1.6; }
.onebot-session-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 20px; }
.onebot-session-list button { padding: 7px 12px; font-size: 13px; color: var(--gc-text-muted); overflow-wrap: anywhere; }
.onebot-session-list button.active { border-color: var(--gc-focus-border); color: var(--gc-focus-border); }
.onebot-empty { padding: 20px; margin: 14px 0 20px; background: var(--gc-surface-muted); border-radius: var(--gc-radius-lg); color: var(--gc-text-muted); text-align: center; }
.onebot-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 14px 0 2px; }
.onebot-card-header h6 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.onebot-card-header small { margin-top: 4px; }
.onebot-card-header button { flex-shrink: 0; }
.onebot-identity { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.onebot-identity img { width: 40px; height: 40px; object-fit: cover; border-radius: var(--gc-radius-sm); }
.onebot-identity div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.onebot-binding { padding: 4px 20px 14px; margin-bottom: 16px; background: var(--gc-surface-raised); border-radius: var(--gc-radius-lg); }
.onebot-actions { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 4px; }
.bot-access-settings{border:1px solid transparent;padding:18px;margin:24px 0;background:var(--gc-surface-raised);border-radius:var(--gc-radius-lg)}.bot-access-settings h3{font-size:17px;margin:0 0 12px}.bot-access-settings p{font-size:13px}.default-permission-editor{padding:18px 0;margin:8px 0 24px;border-bottom:1px solid var(--gc-border-control);scroll-margin-top:20px}.bot-user-rule{padding:12px;margin-top:14px;border:1px solid var(--gc-border-control)}.bot-user-rule.blocked{border-color:var(--gc-danger)}
@media (max-width: 650px) {
  .onebot-header { flex-wrap: wrap; }
  .onebot-tabs button { padding: 10px 12px; }
  .onebot-card { padding: 2px 14px 12px; }
  .onebot-fields>label { align-items: flex-start; flex-wrap: wrap; gap: 10px; }
  .onebot-fields>label>span { width: auto; flex: 1; }
  .onebot-fields>label>input:not([type=checkbox]), .onebot-fields>label>select, .onebot-fields>label>textarea { width: 100%; }
  .onebot-inline { width: 100%; }
  .onebot-card-header { flex-direction: column; gap: 10px; }
  .onebot-identity { flex-wrap: wrap; }
}
@media (max-width: 560px) {
  label { flex-wrap: wrap; gap: 10px; }
  input:not([type=checkbox]), select, textarea { width: 100%; min-width: 0; box-sizing: border-box; }
  .bot-access-settings { padding: 12px; }
}
</style>

<style scoped>
.account-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:18px 0}.account-actions>span{margin-right:auto;color:var(--gc-text-muted);font-size:13px}.account-actions .revoked{color:var(--gc-danger)}.danger-button{color:var(--gc-danger)}.account-delete{padding:12px;border:1px solid var(--gc-danger)}.account-delete button{margin-right:10px}
</style>
