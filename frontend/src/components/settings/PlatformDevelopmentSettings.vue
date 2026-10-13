<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { t } from '../../i18n';
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
  const server = draft({ id: 'custom-' + number, name: t('desktop.developmentUi.customTitle'), languages: [], command: '', args: [] });
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
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(t('desktop.developmentUi.invalidJson', { field: name })); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('desktop.developmentUi.expectedObject', { field: name }));
  return value as Record<string, unknown>;
}
async function save() {
  const disabledIds = new Set(disabled.value);
  for (const server of custom.value) server.enabled ? disabledIds.delete(server.id) : disabledIds.add(server.id);
  const languageServers = custom.value.map(({ key, enabled, languageText, optionsText, settingsText, ...server }) => ({ ...server,
    languages: [...new Set(languageText.split(',').map(value => value.trim()).filter(Boolean))],
    initializationOptions: object(optionsText, t('desktop.developmentUi.initializationField', { name: server.name })),
    settings: object(settingsText, t('desktop.developmentUi.settingsField', { name: server.name })),
  }));
  await sendToExtension('platform.development.update', { settings: { ...settings.value, languageServers, disabledLanguageServers: [...disabledIds] } });
}
async function refreshServices(refresh = true) {
  refreshing.value = true;
  try { services.value = await sendToExtension<LanguageServiceInfo[]>('platform.development.list', { refresh }); error.value = ''; }
  catch (failure) { error.value = String(failure); }
  finally { refreshing.value = false; }
}
function serviceStatus(service: LanguageServiceInfo): string {
  if (custom.value.some(item => item.id === service.id)) return t('desktop.developmentUi.customConfig');
  if (!isEnabled(service.id)) return t('desktop.developmentUi.disabled');
  if (!service.available) return t('desktop.developmentUi.requiresInstall');
  return t(service.source === 'bundled' ? 'desktop.developmentUi.bundled' : 'desktop.developmentUi.detected');
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
    <h4>{{ t('desktop.developmentUi.title') }}</h4>
    <p>{{ t('desktop.developmentUi.description') }}</p>
    <div class="service-toolbar">
      <span>{{ t('desktop.developmentUi.services') }}</span>
      <button type="button" :disabled="loading || refreshing" @click="refreshServices()">
        {{ t(refreshing ? 'desktop.developmentUi.checking' : 'desktop.developmentUi.recheck') }}
      </button>
    </div>
    <div class="service-list">
      <article v-for="service in services" :key="service.id" class="service-row">
        <div class="service-heading">
          <label><input type="checkbox" :checked="isEnabled(service.id)" :disabled="loading || custom.some(item => item.id === service.id)" @change="toggle(service.id, $event)" /><strong>{{ service.name }}</strong></label>
          <span class="service-status" :class="{ available: service.available && isEnabled(service.id) }">{{ serviceStatus(service) }}</span>
        </div>
        <p>{{ service.languages.join(' · ') }}</p>
        <p v-if="service.requirement">{{ service.requirement }}</p>
        <p v-if="service.source === 'system' && service.available" class="service-command">{{ service.command }}</p>
        <a v-if="service.documentationUrl" :href="service.documentationUrl" target="_blank" rel="noopener noreferrer">
          {{ t('desktop.developmentUi.documentation') }}
        </a>
        <button
          v-if="service.configurationTemplate" type="button" class="configure-service"
          :disabled="loading || custom.some(item => item.id === service.id)" @click="configureService(service)"
        >{{ t('desktop.developmentUi.configure') }}</button>
      </article>
    </div>
    <div class="service-toolbar">
      <span>{{ t('desktop.developmentUi.customTitle') }}</span>
      <button type="button" :disabled="loading" @click="addServer">{{ t('desktop.developmentUi.addService') }}</button>
    </div>
    <p>{{ t('desktop.developmentUi.customDescription') }}</p>
    <article v-for="(server, index) in custom" :key="server.key" :data-server-key="server.key" class="custom-server">
      <div class="service-heading">
        <label><input v-model="server.enabled" type="checkbox" />{{ t('common.enable') }}</label>
        <div class="custom-controls">
          <button type="button" :disabled="index === 0" @click="moveServer(index, -1)">
            {{ t('components.settings.promptSettings.entriesEditor.moveUp') }}
          </button>
          <button type="button" :disabled="index === custom.length - 1" @click="moveServer(index, 1)">
            {{ t('components.settings.promptSettings.entriesEditor.moveDown') }}
          </button>
          <button type="button" @click="removeServer(index)">{{ t('desktop.developmentUi.removeService') }}</button>
        </div>
      </div>
      <p v-if="services.find(item => item.id === server.key)?.requirement">{{ services.find(item => item.id === server.key)?.requirement }}</p>
      <div class="custom-fields">
        <label>{{ t('common.name') }}<input v-model="server.name" :placeholder="t('desktop.developmentUi.namePlaceholder')" /></label>
        <label>
          {{ t('desktop.developmentUi.id') }}
          <input v-model="server.id" :placeholder="t('desktop.developmentUi.idPlaceholder')" spellcheck="false" />
        </label>
        <label>
          {{ t('desktop.developmentUi.languages') }}
          <input v-model="server.languageText" :placeholder="t('desktop.developmentUi.languagesPlaceholder')" spellcheck="false" />
        </label>
        <label>
          {{ t('desktop.developmentUi.command') }}
          <input v-model="server.command" data-language-command :placeholder="t('desktop.developmentUi.commandPlaceholder')" spellcheck="false" />
        </label>
      </div>
      <div class="argument-list">
        <span>{{ t('desktop.developmentUi.arguments') }}</span>
        <div v-for="(_, argumentIndex) in server.args" :key="argumentIndex" class="argument-row">
          <input
            v-model="server.args[argumentIndex]"
            :aria-label="t('desktop.developmentUi.argumentLabel', { name: server.name, index: argumentIndex + 1 })"
            :placeholder="t('desktop.developmentUi.argumentPlaceholder')" spellcheck="false"
          />
          <button type="button" @click="removeArgument(server, argumentIndex)" :aria-label="t('desktop.developmentUi.removeArgument')">
            {{ t('common.remove') }}
          </button>
        </div>
        <button type="button" @click="addArgument(server)">{{ t('desktop.developmentUi.addArgument') }}</button>
      </div>
      <details>
        <summary>{{ t('components.settings.channelSettings.form.advancedOptions.title') }}</summary>
        <label>
          {{ t('desktop.developmentUi.initializationOptions') }}
          <textarea v-model="server.optionsText" spellcheck="false" rows="4"></textarea>
        </label>
        <label>
          {{ t('desktop.developmentUi.settings') }}
          <textarea v-model="server.settingsText" spellcheck="false" rows="4"></textarea>
        </label>
      </details>
    </article>
    <p v-if="error" class="development-error" role="alert">{{ error }}</p>
    <DebugAdapterSettings v-model="settings.debugAdapters" :disabled="loading || !ready" />
    <ExternalAgentSettings />
    <DesktopEditorSettings />
  </section>
</template>
<style scoped>
.development-settings{display:grid;gap:12px;margin-top:16px}h4,p{margin:0}p{color:var(--gc-text-muted);font-size:12px;line-height:1.7}label{display:flex;align-items:center;gap:8px}summary{cursor:pointer;padding:8px 0}.service-toolbar,.service-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.service-toolbar{margin-top:10px;font-weight:600}.service-list{display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}.service-row{display:grid;gap:6px;padding:12px;min-width:0;background:var(--gc-surface-raised);border-radius:var(--gc-radius-lg);}.service-status{font-size:11px;color:var(--gc-text-muted);white-space:nowrap}.service-status.available{color:var(--gc-success)}.service-command{overflow-wrap:anywhere}.service-row a{font-size:12px;color:var(--gc-link);width:fit-content}.custom-server{display:grid;gap:12px;padding:14px;border:1px solid var(--gc-border-subtle)}.custom-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}.custom-fields label,details label{display:grid;gap:6px;font-size:12px}.argument-list{display:grid;gap:8px}.argument-list>button{justify-self:start}.argument-row{display:flex;gap:8px}.argument-row input{flex:1;min-width:0}button{border:1px solid var(--gc-border-control);border-radius:var(--gc-radius-sm);padding:5px 10px;background:var(--gc-button-secondary);color:var(--gc-text-on-secondary);cursor:pointer}button:disabled{opacity:.55;cursor:default}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--gc-border-control);border-radius:var(--gc-radius-sm);background:var(--gc-surface-input);color:var(--gc-text-primary);padding:8px;font:inherit}textarea{font-family:var(--gc-font-code);resize:vertical}.development-error{color:var(--gc-danger)}
</style>
