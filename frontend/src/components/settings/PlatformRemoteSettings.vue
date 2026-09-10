<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { AppSettings, RemoteAccessSettings, RemoteAccessStatus } from '../../../../packages/contracts/src';
import { onMessageFromExtension, sendToExtension } from '../../utils/vscode';
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft';
import { copyToClipboard } from '../../utils/format';
const config = ref<RemoteAccessSettings>({ enabled: false, port: 0 });
const status = ref<RemoteAccessStatus>();
const token = ref(''); const reveal = ref(false); const notice = ref(''); const error = ref(''); const busy = ref(false);
let ready = false; let changed = false; let tokenEdited = false; let refreshEpoch = 0;
const labels: Record<RemoteAccessStatus['state'], string> = { disabled: '未启用', stopped: '本次已停止', starting: '正在启动', listening: '可以连接', stopping: '正在停止', error: '启动失败' };
const date = (value: number) => new Date(value).toLocaleString();
async function refresh() {
  const epoch = ++refreshEpoch;
  const result = await sendToExtension<RemoteAccessStatus>('platform.remote.status', {});
  if (epoch === refreshEpoch) status.value = result;
}
function edit() { changed = true; notice.value = ''; markDesktopSettingsDirty(); }
function changeToken(value: string) {
  token.value = value; tokenEdited = true; config.value.credentialRef = value.trim() ? 'web_access' : status.value?.credentialRef; edit();
}
function generateToken() { changeToken([...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('')); }
async function save() {
  if (!ready || !changed || status.value?.source === 'command_line') return;
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {});
  settings.remoteAccess = { ...config.value, publicOrigin: config.value.publicOrigin?.trim() || undefined };
  await sendToExtension('platform.settings.update', { settings,
    ...(tokenEdited ? { credentials: token.value.trim() ? { web_access: token.value.trim() } : {}, clearCredentialChanges: token.value.trim() ? [] : ['web_access'] } : {}) });
  changed = false; tokenEdited = false;
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await operation(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function start() {
  await save();
  if ((await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) throw new Error('请先保存全部设置，再启动远程入口。');
  await sendToExtension('platform.remote.start', {}); await refresh();
}
async function stop() {
  await sendToExtension('platform.remote.stop', {});
  if (status.value && ['starting', 'listening'].includes(status.value.state)) status.value.state = 'stopping';
  // 网页上的停止请求返回后即将断线，避免再向已经关闭的入口请求状态。
  notice.value = '停止请求已接受。网页断开后，可在部署电脑上再次启动入口。';
}
async function copy(value: string, message: string) {
  if (!await copyToClipboard(value)) throw new Error('复制失败，请手动选择并复制文本。');
  notice.value = message;
}
const unsubscribe = onMessageFromExtension(message => {
  if (message.type === 'command' && message.command === 'platform.remote.changed') void refresh().catch(() => {});
});
onMounted(() => void action(async () => {
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {});
  config.value = { ...settings.remoteAccess ?? { enabled: false, port: 0 } };
  token.value = (await sendToExtension<{ token: string }>('platform.remote.token', {})).token;
  await refresh(); ready = true;
}));
onUnmounted(() => { ++refreshEpoch; unsubscribe(); });
useDesktopSettingsDraft(save, () => ready);
</script>
<template>
  <section class="remote-settings">
    <h4>远程连接</h4><p>在手机或其他浏览器上继续同一台电脑的任务、文件、终端和审批。</p>
    <div v-if="status" class="remote-status"><strong :class="{ failed: status.state === 'error' }">{{ labels[status.state] }}</strong><span>{{ status.deviceName }}</span><button :disabled="busy" @click="action(refresh)">刷新状态</button></div>
    <p v-if="status?.error" role="alert" class="remote-error">{{ status.error }}</p>
    <template v-if="status?.source === 'command_line'"><p>当前入口由启动参数配置。下次启动仍使用这些参数；可以在这里停止本次入口或撤销已登录设备。</p></template>
    <template v-else-if="status">
      <label class="remote-enable"><input v-model="config.enabled" type="checkbox" @change="edit" /><span>启用 Web 入口，关闭主窗口后仍在后台提供连接</span></label>
      <label class="remote-field"><span>监听端口<small>0 由系统选择可用端口；反向代理建议填写固定端口。</small></span><input v-model.number="config.port" type="number" min="0" max="65535" step="1" @input="edit" /></label>
      <label class="remote-field"><span>HTTPS 访问地址<small>留空时供本机浏览器使用。远程访问需要已配置的 HTTPS 代理。</small></span><input v-model="config.publicOrigin" type="url" placeholder="https://graycode.example.com" @input="edit" /></label>
      <label class="remote-field"><span>访问令牌<small>{{ config.credentialRef ? '可随时显示或复制已保存的令牌；更换后旧登录立即失效。' : '生成随机令牌，或填写至少 32 个字符的令牌。' }}</small></span><input :value="token" :type="reveal ? 'text' : 'password'" autocomplete="new-password" spellcheck="false" autocapitalize="off" @input="changeToken(($event.target as HTMLInputElement).value)" /></label>
      <div class="remote-actions"><button @click="generateToken">生成新的访问令牌</button><button v-if="token" @click="reveal = !reveal">{{ reveal ? '隐藏' : '显示' }}</button><button v-if="token" @click="action(() => copy(token.trim(), '令牌已复制'))">复制令牌</button></div>
      <p>令牌随设置一起保存，重新打开本页仍可复制。网页登录会长期保留，退出登录、撤销设备或更换令牌后需要重新登录。</p>
      <p>修改端口或 HTTPS 地址后，请使用更新后的地址访问；更换域名时可能需要重新登录。程序只监听本机回环地址，代理、证书和域名由你配置。</p>
    </template>
    <div v-if="status?.address" class="remote-address"><span>浏览器访问地址</span><code>{{ status.address }}/</code><button @click="action(() => copy(status!.address + '/', '访问地址已复制'))">复制地址</button><small v-if="status.address !== status.localAddress">代理上游：{{ status.localAddress }}</small></div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="status" class="remote-actions"><button :disabled="busy || !status.enabled || ['starting','stopping','listening'].includes(status.state)" @click="action(start)">启动已保存的入口</button><button :disabled="busy || !['starting','listening'].includes(status.state)" @click="action(stop)">停止本次入口</button></div>
    <p v-if="status?.state === 'stopped'">本次入口已经停止。核心任务和终端继续运行；下次启动应用时按保存的配置启用。</p>
    <h3>登录设备</h3><p>撤销会断开该设备的网页登录。正在执行的任务仍由核心保存；更换访问令牌会撤销全部登录。</p>
    <div v-for="connection in status?.connections" :key="connection.id" class="remote-connection"><div><strong>{{ connection.name }}</strong><span>{{ connection.connected ? '在线' : '已登录' }} · 最近连接 {{ date(connection.lastSeenAt) }}</span><small v-if="connection.expiresAt">登录到期：{{ date(connection.expiresAt) }}</small></div><button v-if="connection.kind === 'browser'" :disabled="busy" @click="action(async () => { await sendToExtension('platform.remote.revoke', { id: connection.id }); await refresh(); })">撤销登录</button><small v-else>更换令牌可撤销 API 访问</small></div>
    <p v-if="status && !status.connections.length">当前没有已登录设备。</p>
    <p v-if="error" class="remote-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.remote-settings h4{font-size:24px;margin:0 0 12px}.remote-settings h3{font-size:17px;margin:30px 0 12px}.remote-settings p{color:var(--gc-text-muted);line-height:1.7;margin:12px 0 20px}.remote-settings button,.remote-settings input{font:inherit;border:1px solid var(--gc-border-control);border-radius:0;color:var(--gc-text-primary);background:var(--vscode-input-background);padding:8px 12px;min-width:0}.remote-settings button{cursor:pointer;white-space:nowrap}.remote-settings button:disabled{opacity:.45;cursor:default}.remote-status{display:flex;align-items:center;gap:14px;padding:16px 0;border-bottom:1px solid var(--gc-border-subtle)}.remote-status>span{flex:1;color:var(--gc-text-muted);overflow-wrap:anywhere}.remote-enable{display:flex;gap:12px;align-items:center;padding:20px 0}.remote-enable input{width:18px;height:18px;accent-color:var(--vscode-focusBorder)}.remote-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,55%);gap:24px;align-items:center;padding:17px 0;border-bottom:1px solid var(--gc-border-subtle)}.remote-field small{display:block;font-size:12px;color:var(--gc-text-muted);line-height:1.6;margin-top:7px}.remote-actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.remote-address{display:grid;grid-template-columns:1fr auto;gap:12px;padding:18px;border:1px solid var(--gc-border-control)}.remote-address>span,.remote-address>small{grid-column:1/-1;color:var(--gc-text-muted)}.remote-address code{align-self:center;overflow-wrap:anywhere;min-width:0}.remote-connection{display:flex;align-items:center;gap:16px;border-top:1px solid var(--gc-border-subtle);padding:16px 0}.remote-connection>div{flex:1;min-width:0}.remote-connection strong,.remote-connection span,.remote-connection small{display:block;overflow-wrap:anywhere}.remote-connection span,.remote-connection small{font-size:12px;line-height:1.7;color:var(--gc-text-muted);margin-top:5px}.remote-error,.failed{color:var(--gc-danger)!important}@media(max-width:600px){.remote-field{grid-template-columns:1fr;gap:10px}.remote-field input{font-size:16px;width:100%}.remote-status{gap:8px;flex-wrap:wrap}.remote-address{padding:12px}.remote-connection{gap:8px}}
</style>
