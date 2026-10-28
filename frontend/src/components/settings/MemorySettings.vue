<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CustomCheckbox } from '@/components/common'
import { useI18n } from '@/i18n'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'
import { sendToExtension } from '@/utils/vscode'

const { t } = useI18n()
const enabled = ref(true)
const ready = ref(false)
const error = ref('')

async function saveConfig() {
  await sendToExtension('updateSettings', { settings: { toolsConfig: { memory: { enabled: enabled.value } } } })
}

onMounted(async () => {
  try {
    const response = await sendToExtension<{ settings: { toolsConfig: { memory: { enabled: boolean } } } }>('getSettings', {})
    enabled.value = response.settings.toolsConfig.memory.enabled
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
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.memory-settings { display: grid; gap: 16px; width: 100%; }
.memory-error { margin: 0; color: var(--gc-danger); }
</style>
