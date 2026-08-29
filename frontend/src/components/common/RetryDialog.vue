<script setup lang="ts">
/**
 * 重试对话框组件，提供重试、回档并重试选项。
 */

import { computed } from 'vue'
import type { CheckpointRecord } from '../../types'
import { t } from '../../i18n'
import Modal from './Modal.vue'

interface Props {
  modelValue?: boolean
  /** 消息前关联的检查点（before 阶段） */
  checkpoints?: CheckpointRecord[]
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  checkpoints: () => []
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  retry: []
  restoreAndRetry: [checkpointId: string]
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const hasCheckpoints = computed(() => props.checkpoints.length > 0)
const latestCheckpoint = computed(() => {
  if (props.checkpoints.length === 0) return null
  return [...props.checkpoints].sort((a, b) => b.timestamp - a.timestamp)[0]
})

function formatCheckpointDesc(checkpoint: CheckpointRecord): string {
  const toolName = checkpoint.toolName || 'tool'
  const isAfter = checkpoint.phase === 'after'
  if (toolName === 'user_message') {
    return isAfter
      ? t('components.common.retryDialog.restoreToAfterUserMessage')
      : t('components.common.retryDialog.restoreToUserMessage')
  }
  if (toolName === 'model_message') {
    return isAfter
      ? t('components.common.retryDialog.restoreToAfterAssistantMessage')
      : t('components.common.retryDialog.restoreToAssistantMessage')
  }
  if (toolName === 'tool_batch') {
    return isAfter
      ? t('components.common.retryDialog.restoreToAfterToolBatch')
      : t('components.common.retryDialog.restoreToToolBatch')
  }
  return isAfter
    ? t('components.common.retryDialog.restoreToAfterTool').replace('{toolName}', toolName)
    : t('components.common.retryDialog.restoreToTool').replace('{toolName}', toolName)
}

function handleCancel() {
  visible.value = false
  emit('cancel')
}

function handleRetry() {
  visible.value = false
  emit('retry')
}

function handleRestoreAndRetry() {
  if (!latestCheckpoint.value) return
  visible.value = false
  emit('restoreAndRetry', latestCheckpoint.value.id)
}
</script>

<template>
  <Modal
    v-model="visible"
    :aria-label="t('components.common.retryDialog.title')"
    width="420px"
    :closable="false"
    :mask-closable="false"
    body-padding="compact"
    @close="handleCancel"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-refresh" aria-hidden="true"></i>
        <h3>{{ t('components.common.retryDialog.title') }}</h3>
      </div>
    </template>

    <p class="dialog-message">{{ t('components.common.retryDialog.message') }}</p>
    <p v-if="hasCheckpoints" class="checkpoint-hint">
      <i class="codicon codicon-info" aria-hidden="true"></i>
      <span>{{ t('components.common.retryDialog.checkpointHint') }}</span>
    </p>

    <template #footer>
      <button type="button" class="dialog-btn cancel" @click="handleCancel">
        {{ t('components.common.retryDialog.cancel') }}
      </button>
      <button
        v-if="latestCheckpoint"
        type="button"
        class="dialog-btn restore"
        @click="handleRestoreAndRetry"
      >
        <i class="codicon codicon-discard" aria-hidden="true"></i>
        <span>{{ formatCheckpointDesc(latestCheckpoint) }}</span>
      </button>
      <button type="button" class="dialog-btn confirm" @click="handleRetry">
        {{ t('components.common.retryDialog.retry') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.dialog-heading .codicon {
  flex-shrink: 0;
  color: var(--gc-info);
  font-size: var(--gc-icon-size-lg);
}

.dialog-heading h3,
.dialog-message {
  margin: 0;
}

.dialog-heading h3 {
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.dialog-message {
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-normal);
}

.checkpoint-hint {
  margin: 12px 0 0;
  padding: 8px 10px;
  background: var(--vscode-editorInfo-background, rgba(0, 120, 212, 0.1));
  border-radius: 4px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-editorInfo-foreground, #3794ff);
}

.checkpoint-hint .codicon {
  flex-shrink: 0;
  margin-top: 1px;
}

.dialog-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: background-color 0.15s, opacity 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dialog-btn.cancel {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.dialog-btn.cancel:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.dialog-btn.restore {
  background: var(--vscode-editorInfo-foreground);
  color: #fff;
}

.dialog-btn.restore:hover {
  opacity: 0.9;
}

.dialog-btn.restore .codicon {
  font-size: 12px;
}

.dialog-btn.confirm {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.confirm:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
