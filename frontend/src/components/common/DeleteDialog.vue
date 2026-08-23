<script setup lang="ts">
/**
 * 删除对话框组件，提供删除、回档并删除选项。
 */

import { computed } from 'vue'
import type { CheckpointRecord } from '../../types'
import { t } from '../../i18n'
import Modal from './Modal.vue'

interface Props {
  modelValue?: boolean
  /** 消息前关联的检查点 */
  checkpoints?: CheckpointRecord[]
  /** 将要删除的消息数量 */
  deleteCount?: number
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  checkpoints: () => [],
  deleteCount: 1
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  delete: []
  restoreAndDelete: [checkpointId: string]
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

const deleteMessage = computed(() => {
  if (props.deleteCount <= 1) return t('components.common.deleteDialog.message')
  return t('components.common.deleteDialog.messageWithCount')
    .replace('{count}', String(props.deleteCount - 1))
    .replace('{total}', String(props.deleteCount))
})

function formatCheckpointDesc(checkpoint: CheckpointRecord): string {
  const toolName = checkpoint.toolName || 'tool'
  const isAfter = checkpoint.phase === 'after'
  if (toolName === 'user_message') {
    return isAfter
      ? t('components.common.deleteDialog.restoreToAfterUserMessage')
      : t('components.common.deleteDialog.restoreToUserMessage')
  }
  if (toolName === 'model_message') {
    return isAfter
      ? t('components.common.deleteDialog.restoreToAfterAssistantMessage')
      : t('components.common.deleteDialog.restoreToAssistantMessage')
  }
  if (toolName === 'tool_batch') {
    return isAfter
      ? t('components.common.deleteDialog.restoreToAfterToolBatch')
      : t('components.common.deleteDialog.restoreToToolBatch')
  }
  return isAfter
    ? t('components.common.deleteDialog.restoreToAfterTool').replace('{toolName}', toolName)
    : t('components.common.deleteDialog.restoreToTool').replace('{toolName}', toolName)
}

function handleCancel() {
  visible.value = false
  emit('cancel')
}

function handleDelete() {
  visible.value = false
  emit('delete')
}

function handleRestoreAndDelete() {
  if (!latestCheckpoint.value) return
  visible.value = false
  emit('restoreAndDelete', latestCheckpoint.value.id)
}
</script>

<template>
  <Modal
    v-model="visible"
    :aria-label="t('components.common.deleteDialog.title')"
    width="420px"
    :closable="false"
    :mask-closable="false"
    body-padding="compact"
    @close="handleCancel"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-trash" aria-hidden="true"></i>
        <h3>{{ t('components.common.deleteDialog.title') }}</h3>
      </div>
    </template>

    <p class="dialog-message">{{ deleteMessage }}</p>
    <p v-if="hasCheckpoints" class="checkpoint-hint gc-feedback gc-feedback--warning">
      <i class="codicon codicon-info" aria-hidden="true"></i>
      <span>{{ t('components.common.deleteDialog.checkpointHint') }}</span>
    </p>

    <template #footer>
      <button type="button" class="gc-button" @click="handleCancel">
        {{ t('components.common.deleteDialog.cancel') }}
      </button>
      <button
        v-if="latestCheckpoint"
        type="button"
        class="gc-button restore-button"
        @click="handleRestoreAndDelete"
      >
        <i class="codicon codicon-discard" aria-hidden="true"></i>
        <span>{{ formatCheckpointDesc(latestCheckpoint) }}</span>
      </button>
      <button type="button" class="gc-button danger-confirm" @click="handleDelete">
        {{ t('components.common.deleteDialog.delete') }}
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
  color: var(--gc-danger);
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
  margin: var(--gc-space-3) 0 0;
}

.restore-button {
  color: var(--gc-warning);
}

.danger-confirm {
  color: var(--vscode-button-foreground, var(--gc-text-on-accent));
  background: var(--gc-danger);
}

.danger-confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gc-danger) 86%, var(--gc-text-primary));
}
</style>
