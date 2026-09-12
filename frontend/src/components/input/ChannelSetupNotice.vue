<script setup lang="ts">
import { t } from '@/i18n'

export type ChannelSetupStatus = 'loading' | 'error' | 'empty' | 'disabled' | 'channel' | 'models' | 'model' | 'ready'
defineProps<{ status: ChannelSetupStatus; error?: string }>()
defineEmits<{ configure: []; retry: [] }>()
</script>

<template>
  <div v-if="status !== 'ready'" class="channel-setup-notice" :data-status="status"
    :role="status === 'error' ? 'alert' : 'status'" :aria-busy="status === 'loading'">
    <p>{{ t(`components.input.channelSetup.${status}`) }}<span v-if="error" class="setup-error">{{ error }}</span></p>
    <button v-if="status === 'error'" type="button" @click="$emit('retry')">{{ t('common.retry') }}</button>
    <button v-else-if="['empty', 'disabled', 'models'].includes(status)" type="button" @click="$emit('configure')">
      {{ t('components.input.channelSetup.configure') }}
    </button>
  </div>
</template>

<style scoped>
.channel-setup-notice { display: flex; align-items: center; gap: 16px; padding: 10px 12px; margin: 0 0 8px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.6; }
p { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.setup-error { display: block; color: var(--vscode-errorForeground); }
button { flex-shrink: 0; padding: 6px 10px; font: inherit; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 0; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
@media (max-width: 540px) { .channel-setup-notice { align-items: flex-start; flex-direction: column; gap: 8px; } }
</style>
