<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { desktopSettingsDraft as draft, flushDesktopSettings, saveDesktopSettings, discardDesktopSettings } from '../../platform/settingsDraft';
import { sendToExtension } from '../../utils/vscode';
import { t } from '@/i18n';
import Modal from '../common/Modal.vue';
const emit = defineEmits<{ close: [] }>();
const closeDialog = ref(false);
let closeRequested = false;
const savedRecently = ref(false);
let savedFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
function clearSavedFeedback() {
  savedRecently.value = false;
  clearTimeout(savedFeedbackTimer);
  savedFeedbackTimer = undefined;
}
async function save() {
  if (draft.busy || !draft.dirty) return;
  clearSavedFeedback();
  try {
    await saveDesktopSettings();
    savedRecently.value = true;
    savedFeedbackTimer = setTimeout(clearSavedFeedback, 2500);
  } catch { /* 保存错误继续显示在草稿旁。 */ }
}
watch(() => draft.dirty, dirty => {
  if (dirty) clearSavedFeedback();
});
onBeforeUnmount(clearSavedFeedback);
async function requestClose() {
  if (draft.busy || closeRequested || closeDialog.value) return;
  closeRequested = true;
  try {
  try { await flushDesktopSettings(); } catch (error) { draft.error = (error as Error).message; }
  const status = await sendToExtension<{ dirty: boolean }>('ui.settings.status', {});
  if (draft.dirty || status.dirty || draft.error) closeDialog.value = true;
  else { await sendToExtension('ui.settings.end', {}); emit('close'); }
  } catch (error) { draft.error = (error as Error).message; closeDialog.value = true; }
  finally { closeRequested = false; }
}
async function close(action: 'save' | 'discard') {
  try {
    if (action === 'save') await saveDesktopSettings(); else await discardDesktopSettings();
    await sendToExtension('ui.settings.end', {}); closeDialog.value = false;
    // 先让确认框释放模态栈，设置页再把焦点归还到最初的入口。
    await nextTick(); emit('close');
  } catch (error) { draft.error = (error as Error).message; }
}
defineExpose({ requestClose });
</script>
<template>
  <footer class="platform-settings-footer">
    <div>
      <span role="status">{{ t(savedRecently ? 'desktop.settingsDraft.saved' : draft.dirty
        ? 'desktop.settingsDraft.dirtyHint' : 'desktop.settingsDraft.cleanHint') }}</span>
      <p v-if="draft.error" role="alert">{{ draft.error }}</p>
    </div>
    <button :disabled="draft.busy || !draft.dirty" @click="discardDesktopSettings">{{ t('desktop.settingsDraft.discardAll') }}</button>
    <button class="primary" :disabled="draft.busy || !draft.dirty" @click="save">
      {{ t(draft.busy ? 'desktop.settingsDraft.processing' : 'desktop.settingsDraft.saveAll') }}
    </button>
  </footer>
  <Modal v-model="closeDialog" :title="t('desktop.settingsDraft.unsavedTitle')" :closable="false" :mask-closable="false" :close-on-escape="!draft.busy" initial-focus-selector="[data-continue-editing]" width="520px">
    <p>{{ t('desktop.settingsDraft.unsavedDescription') }}</p>
    <p v-if="draft.error" class="save-error" role="alert">{{ draft.error }}</p>
    <div class="platform-close-actions"><button data-continue-editing :disabled="draft.busy" @click="closeDialog = false">{{ t('desktop.settingsDraft.continueEditing') }}</button><button :disabled="draft.busy" @click="close('discard')">{{ t('desktop.settingsDraft.discardAndReturn') }}</button><button class="primary" :disabled="draft.busy" @click="close('save')">{{ t(draft.busy ? 'desktop.settingsDraft.saving' : 'desktop.settingsDraft.saveAndReturn') }}</button></div>
  </Modal>
</template>
<style scoped>
.platform-settings-footer { display: flex; align-items: center; gap: 12px; padding: 16px 24px; background: var(--gc-surface-panel); }
.platform-settings-footer > div { flex: 1; font-size: var(--gc-font-size-body); color: var(--gc-text-muted); }
.platform-settings-footer p { margin: 8px 0 0; color: var(--gc-danger); }
button { color: var(--gc-text-primary); border: 1px solid var(--gc-border-control); background: var(--gc-surface-raised); padding: 8px 16px; font: inherit; cursor: pointer; border-radius: var(--gc-radius-sm); }
button.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); }
button:disabled { cursor: default; opacity: 0.5; }
.platform-close-actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-end; margin-top: 20px; }
.save-error { color: var(--gc-danger); white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 0; }
</style>
