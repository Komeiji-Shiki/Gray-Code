<script setup lang="ts">
import { ref } from 'vue';
import { desktopSettingsDraft as draft, flushDesktopSettings, saveDesktopSettings, discardDesktopSettings } from '../../platform/settingsDraft';
import { sendToExtension } from '../../utils/vscode';
const emit = defineEmits<{ close: [] }>();
const closeDialog = ref(false);
async function save() { try { await saveDesktopSettings(); } catch { /* Error remains alongside the draft. */ } }
async function requestClose() {
  if (draft.busy) return;
  try {
  try { await flushDesktopSettings(); } catch (error) { draft.error = (error as Error).message; }
  const status = await sendToExtension<{ dirty: boolean }>('ui.settings.status', {});
  if (draft.dirty || status.dirty || draft.error) closeDialog.value = true;
  else { await sendToExtension('ui.settings.end', {}); emit('close'); }
  } catch (error) { draft.error = (error as Error).message; closeDialog.value = true; }
}
async function close(action: 'save' | 'discard') {
  try {
    if (action === 'save') await saveDesktopSettings(); else await discardDesktopSettings();
    await sendToExtension('ui.settings.end', {}); closeDialog.value = false; emit('close');
  } catch (error) { draft.error = (error as Error).message; }
}
defineExpose({ requestClose });
</script>
<template>
  <footer class="platform-settings-footer">
    <div><span>{{ draft.dirty ? '有未保存的更改，切换分类会保留草稿。' : '所有分类共用一份设置草稿。' }}</span><p v-if="draft.error" role="alert">{{ draft.error }}</p></div>
    <button :disabled="draft.busy" @click="discardDesktopSettings">撤销全部</button>
    <button class="primary" :disabled="draft.busy" @click="save">{{ draft.busy ? '正在处理…' : '保存全部' }}</button>
  </footer>
  <div v-if="closeDialog" class="platform-close-backdrop"><section role="dialog" aria-modal="true" aria-label="未保存的设置">
    <h3>设置尚未保存</h3><p>可以保存所有分类的更改，或放弃这份草稿后返回对话。</p>
    <p v-if="draft.error" class="save-error" role="alert">{{ draft.error }}</p>
    <div><button :disabled="draft.busy" @click="closeDialog = false">继续编辑</button><button :disabled="draft.busy" @click="close('discard')">放弃并返回</button><button class="primary" :disabled="draft.busy" @click="close('save')">{{ draft.busy ? '正在保存…' : '保存并返回' }}</button></div>
  </section></div>
</template>
<style scoped>
.platform-settings-footer { display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-top: 1px solid var(--gc-border-subtle); background: var(--gc-surface-panel); }
.platform-settings-footer > div { flex: 1; font-size: var(--gc-font-size-body); color: var(--gc-text-muted); }
.platform-settings-footer p { margin: 8px 0 0; color: var(--gc-danger); }
button { color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); background: var(--gc-surface-raised); padding: 8px 16px; font: inherit; cursor: pointer; border-radius: 0; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.platform-close-backdrop { position: fixed; inset: 0; z-index: 5000; display: grid; place-items: center; background: #0008; }
.platform-close-backdrop section { max-width: 520px; padding: 28px; background: var(--gc-surface-panel); border: 1px solid var(--gc-border-control); }
.platform-close-backdrop section > div { display: flex; gap: 12px; justify-content: flex-end; }
.save-error { color: var(--gc-danger); white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 0; }
</style>
