<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CustomCheckbox } from '@/components/common'
import { useI18n } from '@/i18n'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'
import { sendToExtension } from '@/utils/vscode'

const { t } = useI18n()
const isWeb = window.__GRAYCODE_HOST?.kind === 'web'
const enabled = ref(true)
const ready = ref(false)
const error = ref('')
const memoryDirectory = ref('')

async function saveConfig() {
  await sendToExtension('updateSettings', { settings: { toolsConfig: { memory: { enabled: enabled.value } } } })
}

async function openMemoryDirectory() {
  error.value = ''
  try { await sendToExtension('storagePath.openInExplorer', { subdirectory: 'memory' }) }
  catch (cause) { error.value = (cause as Error).message }
}

onMounted(async () => {
  try {
    const [response, storage] = await Promise.all([
      sendToExtension<{ settings: { toolsConfig: { memory: { enabled: boolean } } } }>('getSettings', {}),
      sendToExtension<{ effectivePath: string }>('storagePath.getConfig', {}),
    ])
    enabled.value = response.settings.toolsConfig.memory.enabled
    memoryDirectory.value = storage.effectivePath.replace(/[\\/]$/, '') + '/memory'
    ready.value = true
  } catch (cause) { error.value = (cause as Error).message }
})
useDesktopSettingsDraft(saveConfig, () => ready.value)
</script>

<template>
  <section class="memory-settings" data-search-anchor="memory-toggle">
    <CustomCheckbox
      v-model="enabled"
      :label="t('components.settings.settingsPanel.memory.enabled.label')"
      :disabled="!ready"
    />
    <button type="button" data-search-anchor="memory-directory" :disabled="!ready || isWeb" @click="openMemoryDirectory">
      {{ t('components.settings.settingsPanel.memory.openDirectory') }}
    </button>
    <p v-if="ready" class="memory-location">{{ t('components.settings.settingsPanel.memory.location', { path: memoryDirectory }) }}</p>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.memory-settings { display: grid; gap: 16px; width: 100%; }
.memory-location { margin: 0; color: var(--gc-text-muted); line-height: 1.7; overflow-wrap: anywhere; }
button {
  justify-self: start;
  padding: 8px 12px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  color: var(--gc-text-primary);
  background: var(--gc-surface-raised);
  font: inherit;
  cursor: pointer;
}
button:hover { background: var(--gc-surface-hover); }
button:disabled { cursor: default; opacity: .5; }
.memory-error { margin: 0; color: var(--gc-danger); }
</style>
