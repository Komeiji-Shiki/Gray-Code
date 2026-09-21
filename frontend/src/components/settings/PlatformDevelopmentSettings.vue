<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { DevelopmentSettings, LanguageServerDefinition, LanguageServiceInfo } from '@graycode/contracts';
import { sendToExtension } from '../../utils/vscode';
import { markDesktopSettingsDirty, useDesktopSettingsDraft } from '../../platform/settingsDraft';
import DesktopEditorSettings from './DesktopEditorSettings.vue';
import DebugAdapterSettings from './DebugAdapterSettings.vue';
import ExternalAgentSettings from './ExternalAgentSettings.vue';
interface ServerDraft extends LanguageServerDefinition { key: string; enabled: boolean; languageText: string; optionsText: string; settingsText: string }
const settings = ref<DevelopmentSettings>({});
const disabled = ref<string[]>([]);
const services = ref<LanguageServiceInfo[]>([]);
const custom = ref<ServerDraft[]>([]);
const loading = ref(true);
const ready = ref(false);
const refreshing = ref(false);
const error = ref('');
const section = ref<HTMLElement>();
const isEnabled = (id: string) => custom.value.find(server => server.id === id)?.enabled ?? !disabled.value.includes(id);
function toggle(id: string, event: Event) {
  const next = new Set(disabled.value);
  (event.target as HTMLInputElement).checked ? next.delete(id) : next.add(id);
  disabled.value = [...next];
}
function draft(server: LanguageServerDefinition): ServerDraft {
  return { ...server, args: [...server.args], key: server.id, enabled: isEnabled(server.id), languageText: server.languages.join(', '),
    optionsText: server.initializationOptions ? JSON.stringify(server.initializationOptions, null, 2) : '',
    settingsText: server.settings ? JSON.stringify(server.settings, null, 2) : '' };
}
function addServer() {
  let number = 1;
  while (disabled.value.includes('custom-' + number) || custom.value.some(server => server.id === 'custom-' + number || server.key === 'custom-' + number)) number++;
  const server = draft({ id: 'custom-' + number, name: '自定义语言服务', languages: [], command: '', args: [] });
  custom.value.push(server); void focusServer(server.key);
  markDesktopSettingsDirty();
}
function removeServer(index: number) { custom.value.splice(index, 1); markDesktopSettingsDirty(); }
function moveServer(index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= custom.value.length) return;
  [custom.value[index], custom.value[target]] = [custom.value[target], custom.value[index]];
  markDesktopSettingsDirty();
}
function addArgument(server: ServerDraft) { server.args.push(''); markDesktopSettingsDirty(); }
function removeArgument(server: ServerDraft, index: number) { server.args.splice(index, 1); markDesktopSettingsDirty(); }
function configureService(service: LanguageServiceInfo) {
  if (!service.configurationTemplate || custom.value.some(server => server.id === service.id)) return;
  const server = draft(service.configurationTemplate);
  custom.value.push(server); void focusServer(server.key); markDesktopSettingsDirty();
}
async function focusServer(key: string) {
  await nextTick();
  const target = [...section.value?.querySelectorAll<HTMLElement>('.custom-server') ?? []].find(element => element.dataset.serverKey === key);
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  target?.querySelector<HTMLInputElement>('[data-language-command]')?.focus({ preventScroll: true });
}
function object(text: string, name: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + '必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
async function save() {
  const disabledIds = new Set(disabled.value);
  for (const server of custom.value) server.enabled ? disabledIds.delete(server.id) : disabledIds.add(server.id);
  const languageServers = custom.value.map(({ key, enabled, languageText, optionsText, settingsText, ...server }) => ({ ...server,
    languages: [...new Set(languageText.split(',').map(value => value.trim()).filter(Boolean))],
    initializationOptions: object(optionsText, server.name + '的初始化选项'), settings: object(settingsText, server.name + '的服务设置'),
  }));
  await sendToExtension('platform.development.update', { settings: { ...settings.value, languageServers, disabledLanguageServers: [...disabledIds] } });
}
async function refreshServices(refresh = true) {
  refreshing.value = true;
  try { services.value = await sendToExtension<LanguageServiceInfo[]>('platform.development.list', { refresh }); error.value = ''; }
  catch (failure) { error.value = String(failure); }
  finally { refreshing.value = false; }
}
useDesktopSettingsDraft(save, () => ready.value);
onMounted(async () => {
  try {
    settings.value = await sendToExtension<DevelopmentSettings>('platform.development.get', {});
    disabled.value = [...(settings.value.disabledLanguageServers ?? [])];
    custom.value = (settings.value.languageServers ?? []).map(draft);
    ready.value = true;
    await refreshServices(false);
  } catch (failure) { error.value = String(failure); }
  finally { loading.value = false; }
});
</script>
<template>
  <section ref="section" class="development-settings" data-search-anchor="language-services" :aria-busy="loading">
    <h4>代码补全与报错提示</h4>
    <p>打开文件时按语言启动服务，补全、跳转与报错提示会使用尚未保存的编辑内容。内置服务随程序提供，其他服务需要安装在执行项目的电脑上。</p>
    <div class="service-toolbar"><span>语言服务</span><button type="button" :disabled="loading || refreshing" @click="refreshServices()">{{ refreshing ? '正在检测…' : '重新检测' }}</button></div>
    <div class="service-list">
      <article v-for="service in services" :key="service.id" class="service-row">
        <div class="service-heading">
          <label><input type="checkbox" :checked="isEnabled(service.id)" :disabled="loading || custom.some(item => item.id === service.id)" @change="toggle(service.id, $event)" /><strong>{{ service.name }}</strong></label>
          <span class="service-status" :class="{ available: service.available && isEnabled(service.id) }">{{ custom.some(item => item.id === service.id) ? '使用自定义配置' : !isEnabled(service.id) ? '已停用' : service.available ? service.source === 'bundled' ? '内置可用' : '已检测到' : '需要安装' }}</span>
        </div>
        <p>{{ service.languages.join(' · ') }}</p>
        <p v-if="service.requirement">{{ service.requirement }}</p>
        <p v-if="service.source === 'system' && service.available" class="service-command">{{ service.command }}</p>
        <a v-if="service.documentationUrl" :href="service.documentationUrl" target="_blank" rel="noopener noreferrer">安装与配置说明</a>
        <button v-if="service.configurationTemplate" type="button" class="configure-service" :disabled="loading || custom.some(item => item.id === service.id)" @click="configureService(service)">自定义路径与参数</button>
      </article>
    </div>
    <div class="service-toolbar"><span>自定义语言服务</span><button type="button" :disabled="loading" @click="addServer">添加服务</button></div>
    <p>需要指定其他程序或启动参数时，在这里添加配置。语言使用标准标识，例如 python、go、vue；相同标识的服务按此列表优先匹配，同名 id 会替换默认服务。</p>
    <article v-for="(server, index) in custom" :key="server.key" :data-server-key="server.key" class="custom-server">
      <div class="service-heading"><label><input v-model="server.enabled" type="checkbox" />启用</label><div class="custom-controls"><button type="button" :disabled="index === 0" @click="moveServer(index, -1)">上移</button><button type="button" :disabled="index === custom.length - 1" @click="moveServer(index, 1)">下移</button><button type="button" @click="removeServer(index)">移除服务</button></div></div>
      <p v-if="services.find(item => item.id === server.key)?.requirement">{{ services.find(item => item.id === server.key)?.requirement }}</p>
      <div class="custom-fields">
        <label>名称<input v-model="server.name" placeholder="例如：项目 Python 服务" /></label>
        <label>唯一标识<input v-model="server.id" placeholder="例如：project-python" spellcheck="false" /></label>
        <label>语言标识<input v-model="server.languageText" placeholder="使用逗号分隔，例如 python" spellcheck="false" /></label>
        <label>启动程序<input v-model="server.command" data-language-command placeholder="程序名称或完整路径" spellcheck="false" /></label>
      </div>
      <div class="argument-list">
        <span>启动参数</span>
        <div v-for="(_, argumentIndex) in server.args" :key="argumentIndex" class="argument-row"><input v-model="server.args[argumentIndex]" :aria-label="server.name + ' 参数 ' + (argumentIndex + 1)" placeholder="每项填写一个参数，例如 --stdio" spellcheck="false" /><button type="button" @click="removeArgument(server, argumentIndex)" aria-label="移除参数">移除</button></div>
        <button type="button" @click="addArgument(server)">添加参数</button>
      </div>
      <details><summary>高级选项</summary><label>初始化选项（JSON 对象）<textarea v-model="server.optionsText" spellcheck="false" rows="4"></textarea></label><label>服务设置（JSON 对象）<textarea v-model="server.settingsText" spellcheck="false" rows="4"></textarea></label></details>
    </article>
    <p v-if="error" class="development-error" role="alert">{{ error }}</p>
    <DebugAdapterSettings v-model="settings.debugAdapters" :disabled="loading || !ready" />
    <ExternalAgentSettings />
    <DesktopEditorSettings />
  </section>
</template>
<style scoped>
.development-settings{display:grid;gap:12px;margin-top:16px}h4,p{margin:0}p{color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.7}label{display:flex;align-items:center;gap:8px}summary{cursor:pointer;padding:8px 0}.service-toolbar,.service-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.service-toolbar{margin-top:10px;font-weight:600}.service-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));border-top:1px solid var(--vscode-panel-border);border-left:1px solid var(--vscode-panel-border)}.service-row{display:grid;gap:6px;padding:12px;min-width:0;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}.service-status{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.service-status.available{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}.service-command{overflow-wrap:anywhere}.service-row a{font-size:12px;color:var(--vscode-textLink-foreground);width:fit-content}.custom-server{display:grid;gap:12px;padding:14px;border:1px solid var(--vscode-panel-border)}.custom-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}.custom-fields label,details label{display:grid;gap:6px;font-size:12px}.argument-list{display:grid;gap:8px}.argument-list>button{justify-self:start}.argument-row{display:flex;gap:8px}.argument-row input{flex:1;min-width:0}button{border:1px solid var(--vscode-panel-border);border-radius:0;padding:5px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}button:disabled{opacity:.55;cursor:default}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:8px;font:inherit}textarea{font-family:var(--vscode-editor-font-family);resize:vertical}.development-error{color:var(--vscode-errorForeground)}
</style>
