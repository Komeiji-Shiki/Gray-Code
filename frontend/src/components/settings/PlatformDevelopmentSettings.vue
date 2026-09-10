<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sendToExtension } from '../../utils/vscode';
import { useDesktopSettingsDraft } from '../../platform/settingsDraft';
import DesktopEditorSettings from './DesktopEditorSettings.vue';
interface Settings { disabledLanguageServers?: string[]; languageServers?: unknown[]; debugAdapters?: unknown[] }
const settings = ref<Settings>({});
const enabled = ref(true);
const custom = ref('[]');
const loading = ref(true);
const error = ref('');
async function save() {
  const languageServers = JSON.parse(custom.value);
  if (!Array.isArray(languageServers)) throw new Error('语言服务配置必须是 JSON 数组。');
  const disabled = new Set(settings.value.disabledLanguageServers ?? []);
  enabled.value ? disabled.delete('typescript') : disabled.add('typescript');
  await sendToExtension('platform.development.update', { settings: { ...settings.value, languageServers, disabledLanguageServers: [...disabled] } });
}
useDesktopSettingsDraft(save, () => !loading.value);
onMounted(async () => {
  try {
    settings.value = await sendToExtension<Settings>('platform.development.get', {});
    enabled.value = !settings.value.disabledLanguageServers?.includes('typescript');
    custom.value = JSON.stringify(settings.value.languageServers ?? [], null, 2);
  } catch (failure) { error.value = String(failure); }
  finally { loading.value = false; }
});
</script>
<template>
  <section class="development-settings" :aria-busy="loading">
    <h4>代码补全与报错提示</h4>
    <p>编辑器支持 TypeScript 和 JavaScript 项目。补全、定义、引用、重命名和格式化会使用尚未保存的编辑内容。</p>
    <label><input v-model="enabled" type="checkbox" :disabled="loading" />启用 TypeScript / JavaScript 语言服务</label>
    <details><summary>其他语言服务</summary>
      <p>可以添加使用标准输入输出通信的 LSP 服务。每项填写 id、name、languages、command 和 args；可选 initializationOptions、settings。自定义服务按列表顺序优先匹配语言，启动程序必须已安装在运行服务的电脑上。</p>
      <textarea v-model="custom" :disabled="loading" spellcheck="false" aria-label="自定义语言服务 JSON" rows="10"></textarea>
    </details>
    <p v-if="error" class="development-error">{{ error }}</p>
    <DesktopEditorSettings />
  </section>
</template>
<style scoped>
.development-settings{display:grid;gap:12px;margin-top:28px;padding-top:20px;border-top:1px solid var(--vscode-panel-border)}h4,p{margin:0}p{color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.7}label{display:flex;align-items:center;gap:8px}details{display:grid}summary{cursor:pointer;padding:8px 0}textarea{box-sizing:border-box;width:100%;margin-top:10px;border:1px solid var(--vscode-panel-border);border-radius:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:10px;font-family:var(--vscode-editor-font-family);resize:vertical}.development-error{color:var(--vscode-errorForeground)}
</style>
