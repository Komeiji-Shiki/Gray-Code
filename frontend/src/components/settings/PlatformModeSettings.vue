<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from '../../i18n';
import { sendToExtension } from '../../utils/vscode';
type Mode = 'chat' | 'code' | 'character';
interface Profile { promptModeId?: string; toolNames?: string[] }
const { t } = useI18n();
const modes: Mode[] = ['chat', 'code', 'character'];
const profiles = ref<Partial<Record<Mode, Profile>>>({});
const presets = ref<Array<{ id: string; name: string }>>([]);
const tools = ref<Array<{ name: string }>>([]);
const defaultChatToolNames = ref<string[]>([]);
const error = ref('');
const loading = ref(true);
async function createCharacterPreset() {
  loading.value = true;
  error.value = '';
  try {
    const preset = await sendToExtension<{ id: string; name: string }>('platform.modes.createCharacterPreset', {});
    presets.value.push(preset);
    profiles.value.character = { ...profiles.value.character, promptModeId: preset.id };
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
}
async function save(mode: Mode) {
  try {
    error.value = '';
    await sendToExtension('platform.modes.update', { mode, ...profiles.value[mode] });
  }
  catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
}
function policy(mode: Mode, explicit: boolean) {
  profiles.value[mode]!.toolNames = explicit ? (mode === 'chat' ? [...defaultChatToolNames.value] : []) : undefined;
  void save(mode);
}
function toggle(mode: Mode, name: string, enabled: boolean) {
  const names = new Set(profiles.value[mode]!.toolNames);
  enabled ? names.add(name) : names.delete(name);
  profiles.value[mode]!.toolNames = [...names];
  void save(mode);
}
onMounted(async () => {
  try {
    const result = await sendToExtension<{
      profiles: typeof profiles.value;
      presets: typeof presets.value;
      tools: typeof tools.value;
      defaultChatToolNames: string[];
    }>('platform.modes.get', {});
    profiles.value = Object.fromEntries(modes.map(mode => [mode, result.profiles[mode] ?? {}]));
    presets.value = result.presets;
    tools.value = result.tools;
    defaultChatToolNames.value = result.defaultChatToolNames;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
});
</script>
<template>
  <section class="mode-settings">
    <h4>{{ t('desktop.modeSettings.title') }}</h4>
    <p>{{ t('desktop.modeSettings.description') }}</p>
    <p v-if="loading">{{ t('desktop.modeSettings.loading') }}</p>
    <template v-else>
      <div v-for="mode in modes" :key="mode" class="mode-profile">
        <strong>{{ t(`desktop.shell.${mode}`) }}</strong>
        <button v-if="mode === 'character'" :disabled="loading" @click="createCharacterPreset">
          {{ t('desktop.modeSettings.createCharacterPreset') }}
        </button>
        <template v-if="profiles[mode]">
          <label>
            {{ t('desktop.modeSettings.defaultPreset') }}
            <select v-model="profiles[mode]!.promptModeId" @change="save(mode)">
              <option :value="undefined">{{ t('desktop.modeSettings.inheritPreset') }}</option>
              <option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
            </select>
          </label>
          <label>
            {{ t('desktop.modeSettings.toolScope') }}
            <select
              :value="profiles[mode]!.toolNames !== undefined ? 'selected' : 'inherit'"
              @change="policy(mode, ($event.target as HTMLSelectElement).value === 'selected')"
            >
              <option value="inherit">
                {{ mode === 'chat'
                  ? t('desktop.modeSettings.defaultChatTools', { count: defaultChatToolNames.length })
                  : t('desktop.modeSettings.inheritAgentTools') }}
              </option>
              <option value="selected">{{ t('desktop.modeSettings.selectedTools') }}</option>
            </select>
          </label>
          <div v-if="profiles[mode]!.toolNames !== undefined" class="mode-tools">
            <label v-for="tool in tools" :key="tool.name">
              <input
                type="checkbox"
                :checked="profiles[mode]!.toolNames!.includes(tool.name)"
                @change="toggle(mode, tool.name, ($event.target as HTMLInputElement).checked)"
              />
              {{ tool.name }}
            </label>
          </div>
          <p v-if="profiles[mode]!.toolNames?.length === 0">{{ t('desktop.modeSettings.noTools') }}</p>
        </template>
      </div>
    </template>
    <p v-if="error" role="alert" class="mode-error">{{ error }}</p>
  </section>
</template>
<style scoped>
.mode-settings { padding-top: 18px; margin-top: 18px; }
h4 { margin: 0 0 8px; }
p { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
.mode-profile { display: grid; gap: 10px; padding: 16px 0; }
.mode-profile > label { display: flex; gap: 14px; align-items: center; }
select {
  flex: 1;
  min-width: 0;
  padding: 7px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
}
.mode-tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px; }
.mode-tools label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.mode-error { color: var(--gc-danger); }
.mode-profile > button {
  justify-self: start;
  padding: 7px 12px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-input);
  color: var(--gc-text-primary);
  cursor: pointer;
}
</style>
