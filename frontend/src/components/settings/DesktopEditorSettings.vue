<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sendToExtension } from '../../utils/vscode';
interface Registration { supported: boolean; registered: boolean; otherVersion: boolean; executable: string; extensions: string[]; reason?: string }
const desktop = !!window.__GRAYCODE_HOST && window.__GRAYCODE_HOST.kind !== 'web';
const registration = ref<Registration>();
const busy = ref(false); const notice = ref(''); const error = ref('');
async function action(operation: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = '';
  try { await operation(); } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { busy.value = false; }
}
async function register() {
  registration.value = await sendToExtension<Registration>('desktop.editor.register', {});
  notice.value = 'GrayCode 已加入“打开方式”，可以在 Windows 中选择默认文件类型。';
}
async function defaults() {
  await sendToExtension('desktop.editor.defaults', {});
  notice.value = '已打开 Windows 默认应用设置，选择需要由 GrayCode 默认打开的文件类型。';
}
onMounted(() => { if (desktop) void action(async () => { registration.value = await sendToExtension<Registration>('desktop.editor.status', {}); }); });
</script>
<template>
  <section v-if="desktop" class="editor-registration" data-search-anchor="desktop-editor">
    <h4>Windows 文件关联</h4>
    <p>将 GrayCode 注册为代码编辑器后，可在文件的“打开方式”中选择它。设为某种文件的默认应用后，双击该类型的文件会在 GrayCode 中打开。</p>
    <template v-if="registration?.supported">
      <p>{{ registration.registered ? '当前程序已注册为代码编辑器。' : registration.otherVersion ? '已注册另一位置的 GrayCode，可以更新为当前程序。' : '当前程序尚未注册为代码编辑器。' }}</p>
      <code class="executable">{{ registration.executable }}</code>
      <div class="actions">
        <button :disabled="busy || registration.registered" @click="action(register)">{{ registration.otherVersion ? '更新为当前程序' : '注册为代码编辑器' }}</button>
        <button :disabled="busy || !registration.registered" @click="action(defaults)">选择默认文件类型</button>
      </div>
      <details><summary>支持的文件类型</summary><p class="extensions">{{ registration.extensions.join('　') }}</p></details>
      <p>移动程序文件夹后，请从新位置重新注册。此操作立即生效，无需保存其他设置。</p>
    </template>
    <p v-else-if="registration">{{ registration.reason }}</p>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.editor-registration{display:grid;gap:12px;margin-top:20px;padding-top:20px;border-top:1px solid var(--vscode-panel-border)}h4,p{margin:0}p{color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.7}.executable,.extensions{overflow-wrap:anywhere}.executable{font-size:12px}.actions{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;border:1px solid var(--vscode-panel-border);border-radius:0;padding:8px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);cursor:pointer}button:disabled{opacity:.45;cursor:default}summary{cursor:pointer}.error{color:var(--vscode-errorForeground)}
</style>
