<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AppSettings, ClawdSettings, ClawdStatus } from '../../../../packages/contracts/src/settings';
import { useI18n } from '@/i18n';
import { sendToExtension } from '@/utils/vscode';
import { desktopSettingsDraft, markDesktopSettingsDirty, useDesktopSettingsDraft } from '@/platform/settingsDraft';

const { t } = useI18n();
const label = (key: string) => t(`components.settings.clawdSettings.${key}`);
const configuration = ref<ClawdSettings>({ enabled: false, agentId: '' });
const status = ref<ClawdStatus>({ state: 'disabled' });
const ready = ref(false), busy = ref(false), error = ref('');
let editVersion = 0, savedVersion = 0;
function edit() { editVersion++; error.value = ''; markDesktopSettingsDirty(); }
async function save() {
  if (!ready.value || editVersion === savedVersion) return;
  const version = editVersion;
  const value = { ...configuration.value, agentId: configuration.value.agentId.trim() };
  const settings = await sendToExtension<AppSettings>('platform.settings.get', {});
  await sendToExtension('platform.settings.update', { settings: { ...settings, clawd: value } });
  savedVersion = version;
}
async function check() {
  error.value = '';
  if (editVersion !== savedVersion || desktopSettingsDraft.dirty) { error.value = label('saveFirst'); return; }
  busy.value = true;
  try {
    if ((await sendToExtension<{ dirty: boolean }>('ui.settings.status', {})).dirty) { error.value = label('saveFirst'); return; }
    status.value = await sendToExtension<ClawdStatus>('platform.clawd.check', {});
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  try {
    const settings = await sendToExtension<AppSettings>('platform.settings.get', {});
    configuration.value = { ...settings.clawd ?? { enabled: false, agentId: '' } };
    status.value = await sendToExtension<ClawdStatus>('platform.clawd.status', {});
    ready.value = true;
  } catch (cause) { error.value = (cause as Error).message; }
});
useDesktopSettingsDraft(save, () => ready.value);
</script>

<template>
  <section class="clawd-settings" data-search-anchor="clawd-settings">
    <h4>{{ label('title') }}</h4>
    <p>{{ label('description') }}</p>
    <label class="clawd-toggle"><input v-model="configuration.enabled" type="checkbox" :disabled="!ready || busy" @change="edit">{{ label('enabled') }}</label>
    <label class="clawd-field" for="clawd-agent-id">{{ label('agentId') }}
      <input id="clawd-agent-id" v-model="configuration.agentId" type="text" maxlength="80" spellcheck="false" autocomplete="off"
        placeholder="custom-graycode-0123456789ab" :disabled="!ready || busy" @input="edit">
    </label>
    <p>{{ label('setup') }}</p>
    <p>{{ label('hint') }}</p>
    <div class="clawd-status"><button type="button" :disabled="!ready || busy || !configuration.enabled" @click="check">{{ label(busy ? 'checking' : 'check') }}</button>
      <span role="status">{{ label(`status_${status.state}`) }}</span>
    </div>
    <p v-if="error" class="clawd-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.clawd-settings { display: grid; gap: 12px; margin-bottom: 24px; padding: 18px 0; }
h4 { margin: 0; font-size: var(--gc-font-size-title); } p { margin: 0; color: var(--gc-text-muted); line-height: 1.7; font-size: 12px; }
.clawd-toggle, .clawd-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.clawd-toggle input { accent-color: var(--gc-focus-border); } .clawd-field { display: grid; gap: 8px; }
.clawd-field input, button { font: inherit; color: var(--gc-text-primary); background: var(--gc-surface-raised); border: 1px solid var(--gc-border-control); border-radius: var(--gc-radius-sm); padding: 8px 10px; min-width: 0; }
button { cursor: pointer; } button:hover { background: var(--gc-surface-hover); } button:disabled { cursor: default; opacity: .5; }
.clawd-status span { color: var(--gc-text-muted); font-size: 12px; } .clawd-error { color: var(--gc-danger); }
</style>
