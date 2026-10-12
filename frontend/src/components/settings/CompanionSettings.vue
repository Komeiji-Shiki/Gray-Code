<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { actualLanguage, useI18n } from '@/i18n'
import Modal from '../common/Modal.vue'
import { setShellLanguage } from '../../../../apps/client/src/i18n'

const PetManager = defineAsyncComponent(() => import('../../../../apps/client/src/components/PetManager.vue'))
const ScreenSenseSettings = defineAsyncComponent(() => import('../../../../apps/client/src/components/ScreenSenseSettings.vue'))
const { t } = useI18n()
const pets = ref<{ discard: () => Promise<void> }>()
const screenSense = ref<{ discard: () => Promise<void> }>()
const petsDirty = ref(false)
const screenSenseDirty = ref(false)
const confirmLeave = ref(false)
const discarding = ref(false)
const error = ref('')
let pendingNavigation: ((allowed: boolean) => void) | undefined

watch(actualLanguage, setShellLanguage, { immediate: true })
function prepareNavigation(): Promise<boolean> {
  if (!petsDirty.value && !screenSenseDirty.value) return Promise.resolve(true)
  if (pendingNavigation) return Promise.resolve(false)
  confirmLeave.value = true
  return new Promise(resolve => { pendingNavigation = resolve })
}
async function finishNavigation(allowed: boolean) {
  confirmLeave.value = false
  await nextTick()
  pendingNavigation?.(allowed)
  pendingNavigation = undefined
}
async function discardAndLeave() {
  discarding.value = true
  error.value = ''
  try {
    if (petsDirty.value) await pets.value?.discard()
    if (screenSenseDirty.value) await screenSense.value?.discard()
    await finishNavigation(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    discarding.value = false
  }
}
onBeforeUnmount(() => pendingNavigation?.(false))
defineExpose({ prepareNavigation })
</script>

<template>
  <div class="companion-settings" data-preference-transient>
    <p class="save-hint">{{ t('components.settings.companionSettings.saveHint') }}</p>
    <section data-search-anchor="companion-pet-preferences">
      <PetManager ref="pets" embedded section="preferences" @dirty="petsDirty = $event" />
    </section>
    <section data-search-anchor="companion-vision-defaults">
      <ScreenSenseSettings ref="screenSense" embedded section="defaults" @dirty="screenSenseDirty = $event" />
    </section>
  </div>
  <Modal :model-value="confirmLeave" :title="t('components.settings.companionSettings.unsavedTitle')"
    :closable="false" :mask-closable="false" :close-on-escape="!discarding" initial-focus-selector="[data-continue-editing]"
    @update:model-value="!$event && finishNavigation(false)">
    <p>{{ t('components.settings.companionSettings.unsavedDescription') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="leave-actions">
      <button type="button" data-continue-editing :disabled="discarding" @click="finishNavigation(false)">{{ t('desktop.settingsDraft.continueEditing') }}</button>
      <button type="button" :disabled="discarding" @click="discardAndLeave">{{ t('components.settings.companionSettings.discardAndLeave') }}</button>
    </div>
  </Modal>
</template>

<style scoped>
.companion-settings { display: grid; gap: var(--gc-space-6); }
section { min-width: 0; }
.save-hint { margin: 0; color: var(--gc-text-muted); line-height: 1.7; }
.leave-actions { display: flex; gap: var(--gc-space-3); justify-content: flex-end; margin-top: var(--gc-space-5); }
.leave-actions button {
  padding: var(--gc-space-2) var(--gc-space-3);
  color: var(--gc-text-primary);
  background: var(--gc-surface-raised);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  font: inherit;
  cursor: pointer;
}
.error { color: var(--gc-danger); }
</style>
