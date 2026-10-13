<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../i18n'
import { getToolFileError } from '../../../utils/toolErrors'
import { messageWorkspaceUriKey } from '../../../composables/messageConversationContext'
import '../../../styles/disclosure.css'

const props = defineProps<{ error: string; code?: unknown; path?: unknown }>()
const { t } = useI18n()
const workspaceUri = inject(messageWorkspaceUriKey, undefined)
const detailsOpen = ref(false)
const fileError = computed(() => getToolFileError(props.code,
  typeof props.path === 'string' ? props.path : undefined, workspaceUri?.value))
</script>

<template>
  <div class="tool-error-message">
    <template v-if="fileError">
      <span>{{ t(`components.tools.fileErrors.${fileError.code}`) }}</span>
      <code v-if="fileError.path" class="error-path">{{ fileError.path }}</code>
      <details class="gc-disclosure" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
        <summary>
          <i class="codicon codicon-chevron-right gc-disclosure-chevron" aria-hidden="true"></i>
          {{ t('components.tools.fileErrors.details') }}
        </summary>
        <pre v-if="detailsOpen" class="gc-disclosure-content">{{ error }}</pre>
      </details>
    </template>
    <span v-else class="error-original">{{ error }}</span>
  </div>
</template>

<style scoped>
.tool-error-message { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
.error-path { margin-left: 6px; font: inherit; font-family: var(--gc-font-code); }
.error-original { white-space: pre-wrap; }
details { margin-top: 4px; }
summary { width: fit-content; color: var(--gc-text-muted); font-size: var(--gc-font-size-caption); }
pre { margin: 6px 0 0; }
</style>
