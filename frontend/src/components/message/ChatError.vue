<script setup lang="ts">
import CustomScrollbar from '../common/CustomScrollbar.vue'
import CopyButton from '../common/CopyButton.vue'
import type { ErrorInfo } from '../../types'
import { useI18n } from '../../i18n'
import { isRetryableError } from '../../stores/chat/messageActions/retryFlows'

defineProps<{ error: ErrorInfo }>()
const emit = defineEmits<{ retry: []; dismiss: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="error-message">
    <div class="error-header">
      <div class="error-icon">⚠</div>
      <div class="error-title">{{ t('components.message.error.title') }}</div>
      <div class="error-actions">
        <CopyButton :text="`${error.code}: ${error.message}`" />
        <button v-if="isRetryableError(error)" class="error-retry" type="button" @click="emit('retry')"
          :title="t('components.message.error.retry')" :aria-label="t('components.message.error.retry')">
          <span class="codicon codicon-refresh"></span>
        </button>
        <button class="error-dismiss" type="button" @click="emit('dismiss')"
          :title="t('components.message.error.dismiss')" :aria-label="t('components.message.error.dismiss')">✕</button>
      </div>
    </div>
    <div class="error-body">
      <CustomScrollbar :max-height="120" :width="4">
        <pre class="error-text-code">{{ error.code }}: {{ error.message }}</pre>
      </CustomScrollbar>
    </div>
  </div>
</template>

<style scoped>
.error-message { display: flex; flex-direction: column; margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px); background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1)); border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3)); border-radius: var(--gc-radius-sm); flex-shrink: 0; overflow: hidden; }
.error-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(0, 0, 0, 0.1); border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2)); }
.error-icon { flex-shrink: 0; font-size: 14px; color: var(--vscode-errorForeground, #f48771); }
.error-title { flex: 1; font-size: 13px; font-weight: 500; color: var(--vscode-foreground); }
.error-body { padding: 12px; }
.error-text-code { font-size: 11px; color: var(--vscode-foreground); line-height: 1.4; word-break: break-word; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); background: rgba(0, 0, 0, 0.15); padding: 8px; border-radius: var(--gc-radius-sm); margin: 0; }
.error-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.error-retry, .error-dismiss { flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.6; cursor: pointer; font-size: 14px; border-radius: var(--gc-radius-sm); transition: opacity 0.2s, background 0.2s; }
.error-retry:hover, .error-dismiss:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.error-retry .codicon { font-size: 14px; }
</style>
