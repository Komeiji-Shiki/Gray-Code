<script setup lang="ts">
import CustomScrollbar from '../common/CustomScrollbar.vue'
import CopyButton from '../common/CopyButton.vue'
import type { ErrorInfo } from '../../types'
import { useI18n } from '../../i18n'
import { computed } from 'vue'
import { isRetryableError } from '../../stores/chat/messageActions/retryFlows'
import { redactDiagnostic } from '@shared/diagnosticText'
import { classifyUpstreamError } from '@shared/upstreamError'

const props = defineProps<{ error: ErrorInfo }>()
const emit = defineEmits<{ retry: []; dismiss: []; switchModel: [model: string]; openChannelSettings: [] }>()
const { t } = useI18n()
// 只给模型请求失败附处理办法；恢复、预览等界面操作的错误没有对应的渠道动作。
const advice = computed(() => isRetryableError(props.error) ? classifyUpstreamError(props.error.message) : undefined)
</script>

<template>
  <div class="error-message">
    <div class="error-header">
      <div class="error-icon">⚠</div>
      <div class="error-title">{{ t('components.message.error.title') }}</div>
      <div class="error-actions">
        <CopyButton :text="redactDiagnostic(`${error.code}: ${error.message}`)" />
        <button v-if="isRetryableError(error)" class="error-retry" type="button" @click="emit('retry')"
          :title="t('components.message.error.retry')" :aria-label="t('components.message.error.retry')">
          <span class="codicon codicon-refresh"></span>
        </button>
        <button class="error-dismiss" type="button" @click="emit('dismiss')"
          :title="t('components.message.error.dismiss')" :aria-label="t('components.message.error.dismiss')">✕</button>
      </div>
    </div>
    <div v-if="advice" class="error-advice">
      <span class="error-advice-text">{{ t(`components.message.error.advice.${advice.kind}`) }}</span>
      <button v-if="advice.replacementModel" class="error-advice-action" type="button"
        @click="emit('switchModel', advice.replacementModel)">{{ t('components.message.error.switchModel', { model: advice.replacementModel }) }}</button>
      <button v-else-if="advice.kind !== 'quota'" class="error-advice-action" type="button"
        @click="emit('openChannelSettings')">{{ t('components.message.error.openChannelSettings') }}</button>
    </div>
    <div class="error-body">
      <CustomScrollbar :max-height="120" :width="4">
        <pre class="error-text-code">{{ error.code }}: {{ error.message }}</pre>
      </CustomScrollbar>
    </div>
  </div>
</template>

<style scoped>
.error-message { display: flex; flex-direction: column; margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px); background: var(--gc-quote-bg); border: 1px solid var(--gc-border-subtle); border-radius: var(--gc-radius-sm); flex-shrink: 0; overflow: hidden; }
.error-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(0, 0, 0, 0.1); border-bottom: 1px solid var(--gc-border-subtle); }
.error-icon { flex-shrink: 0; font-size: 14px; color: var(--gc-danger); }
.error-title { flex: 1; font-size: 13px; font-weight: 500; color: var(--gc-text-primary); }
.error-advice { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 12px 0; font-size: 12px; color: var(--gc-text-primary); }
.error-advice-text { flex: 1; min-width: 0; }
.error-advice-action { flex-shrink: 0; padding: 3px 10px; background: transparent; border: 1px solid var(--gc-border-subtle); border-radius: var(--gc-radius-sm); color: var(--gc-text-primary); font-size: 12px; cursor: pointer; transition: background 0.2s; }
.error-advice-action:hover { background: var(--gc-surface-hover); }
.error-body { padding: 12px; }
.error-text-code { font-size: 11px; color: var(--gc-text-primary); line-height: 1.4; word-break: break-word; white-space: pre-wrap; font-family: var(--gc-font-code); background: rgba(0, 0, 0, 0.15); padding: 8px; border-radius: var(--gc-radius-sm); margin: 0; }
.error-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.error-retry, .error-dismiss { flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--gc-text-primary); opacity: 0.6; cursor: pointer; font-size: 14px; border-radius: var(--gc-radius-sm); transition: opacity 0.2s, background 0.2s; }
.error-retry:hover, .error-dismiss:hover { opacity: 1; background: var(--gc-surface-hover); }
.error-retry .codicon { font-size: 14px; }
</style>
