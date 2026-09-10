<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AppSettings, DiscordChannelSettings, DiscordOutputSettings, DiscordReplyProfile, DiscordTrigger } from '../../../../packages/contracts/src/settings';
import type { CharacterResource } from '../../../../packages/contracts/src/characters';
import type { BotChannel, BotGuild, BotStatus, BotUser } from '../../../../packages/contracts/src/bots';
import { sendToExtension } from '../../utils/vscode';
import { useDesktopSettingsDraft, desktopSettingsDraft, markDesktopSettingsDirty } from '../../platform/settingsDraft';
import DiscordProfileFields from './discord/DiscordProfileFields.vue';
import DiscordOutputFields from './discord/DiscordOutputFields.vue';

interface DeliveryView { id: string; phase: string; channelId: string; conversationId: string; createdAt: number; error?: string; preview: string; completedParts: number; totalParts: number }
const sections = [{ id: 'connection', name: '连接' }, { id: 'defaults', name: '默认回复' }, { id: 'channels', name: '频道' }, { id: 'direct', name: '主人私聊' }, { id: 'bindings', name: '身份绑定' }, { id: 'outbox', name: '待发送' }];
const section = ref('connection');
const settings = ref<AppSettings>();
const bot = computed(() => settings.value?.discord);
const status = ref<BotStatus>({ status: 'stopped' });
const statusLabels: Record<string, string> = { stopped: '已断开', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '连接已断开', failed: '连接失败' };
const error = ref('');
const busy = ref('');
const credentials = ref<Record<string, string | null>>({});
const credentialResets = ref<string[]>([]);
const originalCredentialRef = ref<string>();
const modes = ref<Array<{ id: string; name: string }>>([]);
const resources = ref<Pick<CharacterResource, 'id' | 'name' | 'kind'>[]>([]);
const guilds = ref<BotGuild[]>([]);
const channels = ref<BotChannel[]>([]);
const guildId = ref('');
const query = ref('');
const manualChannelId = ref('');
const selectedChannelId = ref('');
const bindingUsers = ref<Record<string, BotUser>>({});
const deliveries = ref<DeliveryView[]>([]);
const retryAcknowledged = ref<string[]>([]);
const triggers: Array<{ id: DiscordTrigger; label: string }> = [
  { id: 'mention', label: '提及 Bot' }, { id: 'reply', label: '回复 Bot 的消息' }, { id: 'mention_or_reply', label: '提及或回复 Bot' },
  { id: 'keyword', label: '包含关键词' }, { id: 'all', label: '所有消息' }, { id: 'command', label: '仅 /gray 指令和操作面板' },
];
const legacyOutput: DiscordOutputSettings = { streaming: false, updateIntervalMs: 1000, showThoughts: false, showToolStatus: false, longReplies: 'split' };
const output = computed(() => bot.value?.output ?? legacyOutput);
const baseProfile = computed<DiscordReplyProfile>(() => ({ agentId: bot.value?.agentId, workspaceId: bot.value?.workspaceId }));
const inheritedProfile = computed(() => ({ ...baseProfile.value, ...bot.value?.defaultProfile }));
const selectedChannel = computed(() => selectedChannelId.value ? bot.value?.channels?.[selectedChannelId.value] : undefined);
const visibleChannels = computed(() => channels.value.filter(channel => `${channel.name} ${channel.category ?? ''} ${channel.id}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const discordBindings = computed(() => settings.value?.bindings.filter(item => item.platform === 'discord') ?? []);
const hasOwnerBinding = computed(() => discordBindings.value.some(binding => settings.value?.accounts.some(account => account.id === binding.accountId && account.role === 'owner')));
const defaultTrigger = computed(() => bot.value?.defaultTrigger ?? (bot.value?.mentionOnly ? 'mention' : 'all'));
const needsContentIntent = computed(() => !!bot.value?.allowedChannelIds.length);

async function stage() {
  if (settings.value) await sendToExtension('platform.settings.update', { settings: settings.value, credentials: credentials.value, clearCredentialChanges: credentialResets.value });
}
async function action(label: string, run: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = label; error.value = '';
  try { await run(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = ''; }
}
function changed(event: Event) {
  if (event.target instanceof Element && event.target.closest('[data-preference-transient]')) return;
  void stage().catch(cause => { error.value = (cause as Error).message; });
}
function changedByButton() { markDesktopSettingsDirty(); void stage().catch(cause => { error.value = (cause as Error).message; }); }
async function refreshStatus() { status.value = await sendToExtension('platform.discord.status', {}); }
async function refreshGuilds() {
  const result = await sendToExtension<{ guilds: BotGuild[] }>('platform.discord.guilds', {}); guilds.value = result.guilds;
  if (guildId.value && !guilds.value.some(item => item.id === guildId.value)) { guildId.value = ''; channels.value = []; }
}
async function connect() {
  if (desktopSettingsDraft.dirty || (await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) throw new Error('请先点击下方“保存全部”，再连接 Bot。');
  status.value = await sendToExtension('platform.discord.start', {}); await refreshGuilds();
}
async function refreshChannels() {
  channels.value = [];
  if (!guildId.value) return;
  channels.value = (await sendToExtension<{ channels: BotChannel[] }>('platform.discord.channels', { guildId: guildId.value })).channels;
}
function updateChannel(id: string, patch: Partial<DiscordChannelSettings>) {
  if (!bot.value) return;
  bot.value.channels = { ...bot.value.channels, [id]: { ...bot.value.channels?.[id], ...patch } };
}
function toggleChannel(channel: BotChannel, enabled: boolean) {
  if (!bot.value) return;
  bot.value.allowedChannelIds = enabled ? [...new Set([...bot.value.allowedChannelIds, channel.id])] : bot.value.allowedChannelIds.filter(id => id !== channel.id);
  if (enabled) { updateChannel(channel.id, { name: channel.name, guildId: channel.guildId, guildName: guilds.value.find(item => item.id === channel.guildId)?.name }); selectedChannelId.value = channel.id; }
  changedByButton();
}
function addManualChannel() {
  const id = manualChannelId.value.trim();
  if (!/^\d{1,20}$/.test(id)) { error.value = '请填写 Discord 的数字频道 ID。'; return; }
  toggleChannel({ id, name: bot.value?.channels?.[id]?.name ?? id, available: true, direct: false, type: 'manual' }, true); manualChannelId.value = '';
}
function changeDefaultProfile(value: DiscordReplyProfile) { bot.value!.defaultProfile = value; }
function changeDirectProfile(value: DiscordReplyProfile) { bot.value!.directMessages = { enabled: bot.value!.directMessages?.enabled !== false, profile: value }; }
function setToken(value: string) {
  if (value.trim()) {
    const ref = bot.value!.credentialRef ?? 'discord'; bot.value!.credentialRef = ref; credentials.value[ref] = value.trim();
    credentialResets.value = credentialResets.value.filter(id => id !== ref);
  } else if (bot.value?.credentialRef && credentials.value[bot.value.credentialRef]) {
    const ref = bot.value.credentialRef; delete credentials.value[ref]; credentialResets.value = [...new Set([...credentialResets.value, ref])];
    bot.value.credentialRef = originalCredentialRef.value;
  }
}
function addBinding() {
  settings.value!.bindings.push({ id: `binding_${crypto.randomUUID()}`, platform: 'discord', platformUserId: '', accountId: '' }); markDesktopSettingsDirty();
}
async function lookupUser(id: string) {
  if (!/^\d{1,20}$/.test(id)) throw new Error('请填写数字用户 ID。');
  const user = await sendToExtension<BotUser>('platform.discord.user', { userId: id }); bindingUsers.value[id] = user;
}
async function refreshOutbox() { deliveries.value = (await sendToExtension<{ messages: DeliveryView[] }>('platform.discord.outbox', {})).messages; await refreshStatus(); }
function changeSection(id: string) {
  section.value = id;
  if (id === 'outbox') void action('刷新待发送消息', refreshOutbox);
  if (id === 'channels' && status.value.status === 'connected' && !guilds.value.length) void action('读取服务器', refreshGuilds);
}
onMounted(async () => {
  await action('读取设置', async () => {
    settings.value = await sendToExtension('platform.settings.get', {});
    originalCredentialRef.value = settings.value?.discord.credentialRef;
    const results = await Promise.allSettled([
      refreshStatus(), sendToExtension<{ modes: Array<{ id: string; name: string }> }>('getPromptModes', {}).then(value => { modes.value = value.modes; }),
      sendToExtension<typeof resources.value>('characters.list', {}).then(value => { resources.value = value; }),
    ]);
    const failed = results.find(item => item.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  });
});
useDesktopSettingsDraft(stage, () => !!settings.value);
</script>

<template>
  <div class="discord-settings" @change="changed">
    <header class="discord-header"><div><h4>Discord Bot</h4><p>在 Discord 使用同一套对话、模型与任务。设置通过下方“保存全部”生效。</p></div><span class="discord-status" :class="{ connected: status.status === 'connected' }">{{ statusLabels[status.status] ?? status.status }}</span></header>
    <nav class="discord-tabs" aria-label="Discord 设置分类"><button v-for="item in sections" :key="item.id" :class="{ active: section === item.id }" @click="changeSection(item.id)">{{ item.name }}<span v-if="item.id === 'outbox' && status.pendingMessages"> {{ status.pendingMessages }}</span></button></nav>
    <p v-if="error" role="alert" class="discord-error">{{ error }}</p>
    <p v-if="status.needsReconnect" class="discord-notice">触发方式已经改变。请重新连接 Bot，使消息读取权限生效。</p>
    <template v-if="settings && bot">
      <section v-if="section === 'connection'">
        <div class="discord-fields"><label><span>启动时自动连接<small>已启用的 Bot 在下次启动 GrayCode 时连接；关闭此项后可手动连接。</small></span><input type="checkbox" :checked="bot.autoConnect !== false" @change="bot.autoConnect = ($event.target as HTMLInputElement).checked" /></label></div>
        <div v-if="status.botId" class="discord-identity"><img v-if="status.avatarUrl" :src="status.avatarUrl" alt="Bot 头像" /><div><strong>{{ status.name }}</strong><small>{{ status.botId }}</small></div><span>{{ status.controlsReady ? '/gray 操作面板已注册' : '操作面板尚未就绪' }}</span></div>
        <div class="discord-fields"><label><span>启用 Bot</span><input v-model="bot.enabled" type="checkbox" /></label><label><span>Bot Token<small>填写新值可以替换原凭据，留空保留。</small></span><input type="password" autocomplete="new-password" :placeholder="bot.credentialRef ? '已配置 Bot Token' : '输入 Bot Token'" @input="setToken(($event.target as HTMLInputElement).value)" /></label></div>
        <div class="discord-actions"><button :disabled="!!busy" @click="action('连接 Bot', connect)">{{ busy === '连接 Bot' ? '正在连接…' : '连接 / 重连' }}</button><button :disabled="!!busy || status.status === 'stopped'" @click="action('断开 Bot', async () => { await sendToExtension('platform.discord.stop', {}); await refreshStatus(); guilds = []; channels = []; })">断开</button><button :disabled="!!busy" @click="action('刷新状态', refreshStatus)">刷新状态</button></div>
        <p v-if="status.error || status.warning" class="discord-error">{{ status.error || status.warning }}</p>
        <div class="discord-note"><strong>开始使用</strong><p>保存 Token 并连接后，在“频道”中选择允许响应的频道，再到“身份绑定”关联主人的 Discord 账号。随后输入 /gray，即可管理本频道对话、选择模型与工作区、查看状态和停止任务。</p><p>Bot 邀请需要 bot 和 applications.commands 权限范围。记录群聊背景消息需要在 Discord 开发者后台打开 Message Content Intent，即使只在被 @ 时回复也需要。</p><a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">打开 Discord 开发者后台</a></div>
      </section>
      <section v-else-if="section === 'defaults'">
        <h5>默认回复配置</h5><p>频道与私聊继承这些设置，可以分别覆盖。当前会话在 Discord 中主动选择的模型会保留，直到切回默认配置。</p>
        <DiscordProfileFields :model-value="bot.defaultProfile ?? {}" :inherited="baseProfile" :settings="settings" :modes="modes" :resources="resources" :output="output" @update:model-value="changeDefaultProfile" />
        <h5>默认输出方式</h5><DiscordOutputFields :model-value="output" :inherited="legacyOutput" @update:model-value="bot.output = { ...output, ...$event }" />
      </section>
      <section v-else-if="section === 'channels'">
        <h5>允许响应的频道</h5><p>可以连接 Bot 后按名称选择，也可以手动填写频道 ID。帖子与子频道需要单独选择；未选择的频道不会触发任务。</p>
        <div class="discord-discovery" data-preference-transient><select v-model="guildId" :disabled="!!busy || !guilds.length" aria-label="选择 Discord 服务器" @change="action('读取频道', refreshChannels)"><option value="">选择服务器</option><option v-for="guild in guilds" :key="guild.id" :value="guild.id" :disabled="guild.unavailable">{{ guild.name }}{{ guild.unavailable ? '（暂不可用）' : '' }}</option></select><button :disabled="!!busy || status.status !== 'connected'" @click="action('读取服务器', refreshGuilds)">刷新服务器</button><input v-model="query" type="search" placeholder="搜索频道名称或 ID" aria-label="搜索频道" /></div>
        <div v-if="guildId" class="discord-channel-list"><div v-for="channel in visibleChannels" :key="channel.id" class="discord-channel-row"><label><input type="checkbox" :disabled="!channel.available && !bot.allowedChannelIds.includes(channel.id)" :checked="bot.allowedChannelIds.includes(channel.id)" @change.stop="toggleChannel(channel, ($event.target as HTMLInputElement).checked)" /><span># {{ channel.name }}<small>{{ channel.category || channel.type }} · {{ channel.id }}{{ channel.available ? '' : ' · Bot 无读取或发送权限' }}</small></span></label><button v-if="bot.allowedChannelIds.includes(channel.id)" @click="selectedChannelId = channel.id">配置</button></div><p v-if="!visibleChannels.length">{{ busy === '读取频道' ? '正在读取频道…' : '没有符合条件的频道。' }}</p></div>
        <div class="discord-discovery" data-preference-transient><input v-model="manualChannelId" inputmode="numeric" placeholder="手动添加数字频道 ID" aria-label="手动添加频道 ID" @keydown.enter.prevent="addManualChannel" /><button @click="addManualChannel">添加频道</button></div>
        <div v-if="bot.allowedChannelIds.length" class="discord-selected"><button v-for="id in bot.allowedChannelIds" :key="id" :class="{ active: selectedChannelId === id }" @click="selectedChannelId = id"># {{ bot.channels?.[id]?.name || id }}</button></div>
        <div class="discord-fields"><label><span>默认触发方式</span><select :value="defaultTrigger" @change="bot.defaultTrigger = ($event.target as HTMLSelectElement).value as DiscordTrigger"><option v-for="item in triggers.filter(item => item.id !== 'keyword')" :key="item.id" :value="item.id">{{ item.label }}</option></select></label></div>
        <p v-if="needsContentIntent" class="discord-notice">记录已允许频道的完整群聊上下文需要 Message Content Intent。请在 Discord 开发者后台启用，再保存并重新连接。</p>
        <div v-if="selectedChannelId && bot.allowedChannelIds.includes(selectedChannelId)" class="discord-channel-config">
          <div class="discord-heading"><h5># {{ selectedChannel?.name || selectedChannelId }}</h5><button @click="bot.allowedChannelIds = bot.allowedChannelIds.filter(id => id !== selectedChannelId); selectedChannelId = ''; changedByButton()">停止响应此频道</button></div>
          <div class="discord-fields"><label><span>回复触发方式</span><select :value="selectedChannel?.trigger ?? ''" @change="updateChannel(selectedChannelId, { trigger: (($event.target as HTMLSelectElement).value || undefined) as DiscordTrigger | undefined })"><option value="">继承默认触发方式</option><option v-for="item in triggers" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label v-if="(selectedChannel?.trigger ?? defaultTrigger) === 'keyword'"><span>触发关键词<small>每行一个，命中任意一项即可。</small></span><textarea rows="3" :value="selectedChannel?.keywords?.join('\n') ?? ''" @input="updateChannel(selectedChannelId, { keywords: ($event.target as HTMLTextAreaElement).value.split('\n').map(value => value.trim()).filter(Boolean) })" /></label></div>
          <DiscordProfileFields :key="selectedChannelId" :model-value="selectedChannel?.profile ?? {}" :inherited="inheritedProfile" :settings="settings" :modes="modes" :resources="resources" :output="output" @update:model-value="updateChannel(selectedChannelId, { profile: $event })" />
        </div>
      </section>
      <section v-else-if="section === 'direct'">
        <h5>主人私聊</h5><p>私聊只对绑定到主人身份的 Discord 账号开放，其他已授权账号也不能使用。私聊不需要填写频道 ID。</p>
        <div class="discord-fields"><label><span>允许主人私聊 Bot</span><input type="checkbox" :checked="bot.directMessages?.enabled !== false" @change="bot.directMessages = { ...bot.directMessages, enabled: ($event.target as HTMLInputElement).checked }" /></label></div>
        <p v-if="!hasOwnerBinding" class="discord-notice">还没有绑定主人的 Discord 账号，请先在“身份绑定”中添加。</p>
        <DiscordProfileFields v-if="bot.directMessages?.enabled !== false" :model-value="bot.directMessages?.profile ?? {}" :inherited="inheritedProfile" :settings="settings" :modes="modes" :resources="resources" :output="output" @update:model-value="changeDirectProfile" />
      </section>
      <section v-else-if="section === 'bindings'">
        <h5>Discord 身份绑定</h5><p>Discord 用户 ID 是一串数字。先在 Discord“用户设置 → 高级”打开开发者模式，再右键用户头像，选择“复制用户 ID”。用户名与昵称不能代替 ID。</p>
        <div v-for="binding in discordBindings" :key="binding.id" class="discord-binding">
          <div class="discord-fields"><label><span>Discord 用户 ID</span><input v-model.trim="binding.platformUserId" inputmode="numeric" placeholder="例如：一串 18 至 20 位数字" /></label><label><span>关联身份</span><select v-model="binding.accountId"><option value="" disabled>请选择身份</option><option v-for="account in settings.accounts.filter(item => !item.revoked)" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.role === 'owner' ? '主人，可使用私聊' : '群聊授权账号' }}</option></select></label></div>
          <div v-if="bindingUsers[binding.platformUserId]" class="discord-identity"><img v-if="bindingUsers[binding.platformUserId].avatarUrl" :src="bindingUsers[binding.platformUserId].avatarUrl" alt="Discord 头像" /><div><strong>{{ bindingUsers[binding.platformUserId].displayName }}</strong><small>@{{ bindingUsers[binding.platformUserId].name }}{{ bindingUsers[binding.platformUserId].bot ? ' · 这是机器人账号，请使用自己的用户 ID' : '' }}</small></div></div>
          <div class="discord-actions"><button :disabled="!!busy || status.status !== 'connected' || !binding.platformUserId" @click="action('查询用户', () => lookupUser(binding.platformUserId))">查询用户信息</button><button @click="settings.bindings = settings.bindings.filter(item => item.id !== binding.id); changedByButton()">移除绑定</button></div>
        </div><button @click="addBinding">添加身份绑定</button>
      </section>
      <section v-else>
        <div class="discord-heading"><h5>待发送消息</h5><button :disabled="!!busy" @click="action('刷新待发送消息', refreshOutbox)">刷新</button></div><p>任务记录保存在对话中。连接中断时，已取得回执的消息可以继续更新；没有确认送达的新消息需要人工检查。</p>
        <p v-if="!deliveries.length" class="discord-empty">目前没有待发送消息。</p>
        <article v-for="item in deliveries" :key="item.id" class="discord-delivery"><div class="discord-heading"><strong>{{ item.phase === 'unknown' || item.phase === 'sending' ? '发送结果尚未确认' : item.phase === 'editing' ? '正在更新回复' : '等待发送或更新' }}</strong><small>{{ item.createdAt ? new Date(item.createdAt).toLocaleString() : '旧版消息' }}</small></div><p>频道 {{ bot.channels?.[item.channelId]?.name || item.channelId }} · {{ item.completedParts }} / {{ item.totalParts }} 段</p><pre>{{ item.preview }}</pre><p v-if="item.error" class="discord-error">{{ item.error }}</p><label v-if="item.phase === 'unknown' || item.phase === 'sending'" class="discord-confirm" data-preference-transient><input v-model="retryAcknowledged" type="checkbox" :value="item.id" />已检查频道，允许重试并接受可能重复发送</label><button :disabled="!!busy || status.status !== 'connected' || (['unknown', 'sending'].includes(item.phase) && !retryAcknowledged.includes(item.id))" @click="action('重试发送', async () => { await sendToExtension('platform.discord.retryDelivery', { id: item.id, acknowledgeDuplicateRisk: retryAcknowledged.includes(item.id) }); await refreshOutbox(); })">重试发送</button></article>
      </section>
    </template>
    <p v-else>正在读取 Discord 设置…</p>
  </div>
</template>
<style scoped src="./discord/discordSettings.css"></style>
