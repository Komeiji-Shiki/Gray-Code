<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sendToExtension } from '../../utils/vscode';
type Mode = 'chat' | 'code' | 'character';
interface Profile { promptModeId?: string; toolNames?: string[] }
const modes: Array<{ id: Mode; name: string }> = [{ id: 'chat', name: '普通对话' }, { id: 'code', name: '代码模式' }, { id: 'character', name: '角色对话' }];
const profiles = ref<Partial<Record<Mode, Profile>>>({});
const presets = ref<Array<{ id: string; name: string }>>([]);
const tools = ref<Array<{ name: string }>>([]);
const error = ref('');
const loading = ref(true);
async function createCharacterPreset() {
  loading.value = true; error.value = '';
  try {
    const preset = await sendToExtension<{ id: string; name: string }>('platform.modes.createCharacterPreset', {});
    presets.value.push(preset);
    profiles.value.character = { ...profiles.value.character, promptModeId: preset.id };
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
}
async function save(mode: Mode) {
  try { error.value = ''; await sendToExtension('platform.modes.update', { mode, ...profiles.value[mode] }); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
}
function policy(mode: Mode, explicit: boolean) { profiles.value[mode]!.toolNames = explicit ? [] : undefined; void save(mode); }
function toggle(mode: Mode, name: string, enabled: boolean) {
  const names = new Set(profiles.value[mode]!.toolNames); enabled ? names.add(name) : names.delete(name);
  profiles.value[mode]!.toolNames = [...names]; void save(mode);
}
onMounted(async () => {
  try {
    const result = await sendToExtension<{ profiles: typeof profiles.value; presets: typeof presets.value; tools: typeof tools.value }>('platform.modes.get', {});
    profiles.value = Object.fromEntries(modes.map(mode => [mode.id, result.profiles[mode.id] ?? {}]));
    presets.value = result.presets; tools.value = result.tools;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
});
</script>
<template>
  <section class="mode-settings"><h4>对话模式与预设</h4><p>分别设置普通对话、代码和角色模式。新建对话使用对应预设；已有对话保留自己的预设选择。实际工具仍受工具总开关和账号授权约束。</p>
    <p v-if="loading">正在读取模式配置…</p>
    <template v-else><div v-for="mode in modes" :key="mode.id" class="mode-profile">
      <strong>{{ mode.name }}</strong><button v-if="mode.id === 'character'" :disabled="loading" @click="createCharacterPreset">创建并绑定基础角色预设</button>
      <template v-if="profiles[mode.id]">
        <label>默认预设<select v-model="profiles[mode.id]!.promptModeId" @change="save(mode.id)"><option :value="undefined">沿用当前默认预设</option><option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></select></label>
        <label>工具范围<select :value="profiles[mode.id]!.toolNames ? 'selected' : 'inherit'" @change="policy(mode.id, ($event.target as HTMLSelectElement).value === 'selected')"><option value="inherit">沿用 Agent 工具配置</option><option value="selected">仅选择的工具</option></select></label>
        <div v-if="profiles[mode.id]!.toolNames" class="mode-tools"><label v-for="tool in tools" :key="tool.name"><input type="checkbox" :checked="profiles[mode.id]!.toolNames!.includes(tool.name)" @change="toggle(mode.id, tool.name, ($event.target as HTMLInputElement).checked)" />{{ tool.name }}</label></div>
        <p v-if="profiles[mode.id]!.toolNames?.length === 0">当前模式不启用工具。</p>
      </template>
    </div></template>
    <p v-if="error" role="alert" class="mode-error">{{ error }}</p>
  </section>
</template>
<style scoped>
.mode-settings{padding-top:18px;margin-top:18px;border-top:1px solid var(--vscode-panel-border)}h4{margin:0 0 8px}p{font-size:12px;line-height:1.7;color:var(--vscode-descriptionForeground)}.mode-profile{display:grid;gap:10px;padding:16px 0;border-bottom:1px solid var(--vscode-panel-border)}.mode-profile>label{display:flex;gap:14px;align-items:center}select{flex:1;min-width:0;padding:7px;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}.mode-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px}.mode-tools label{display:flex;align-items:center;gap:6px;font-size:12px}.mode-error{color:var(--vscode-errorForeground)}
.mode-profile>button{justify-self:start;padding:7px 12px;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);cursor:pointer}
</style>
