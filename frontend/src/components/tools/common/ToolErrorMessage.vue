<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../i18n'
import { getToolFileError } from '../../../utils/toolErrors'
import { messageWorkspaceUriKey } from '../../../composables/messageConversationContext'

const props = defineProps<{ error: string; path?: unknown }>()
const { t } = useI18n()
const workspaceUri = inject(messageWorkspaceUriKey, undefined)
const detailsOpen = ref(false)
const fileError = computed(() => getToolFileError(props.error,
  typeof props.path === 'string' ? props.path : undefined, workspaceUri?.value))
</script>

<template>
  <div class="tool-error-message">
    <template v-if="fileError">
      <span>{{ t(`components.tools.fileErrors.${fileError.code}`) }}</span>
      <code v-if="fileError.path" class="error-path">{{ fileError.path }}</code>
      <details @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ t('components.tools.fileErrors.details') }}</summary>
        <pre v-if="detailsOpen">{{ error }}</pre>
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
summary { width: fit-content; color: var(--gc-text-muted); cursor: pointer; font-size: var(--gc-font-size-caption); }
summary:focus-visible { outline: 1px solid var(--gc-focus-border); outline-offset: 2px; }
pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-family: var(--gc-font-code); }
</style>
