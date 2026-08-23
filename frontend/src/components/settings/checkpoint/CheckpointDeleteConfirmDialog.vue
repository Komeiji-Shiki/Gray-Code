<script setup lang="ts">
/** CheckpointDeleteConfirmDialog - 对话或存档点批量删除确认。 */
import { t } from '@/i18n'
import type { DeleteConfirmState } from '@/composables/useCheckpointCleanup'
import { Modal } from '../../common'

defineProps<{
  state: DeleteConfirmState | null
  isBatchDeleting: boolean
  formatSize: (size: number) => string
}>()

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'confirm'): void
}>()
</script>

<template>
  <Modal
    :model-value="!!state"
    :aria-label="t('components.settings.checkpoint.sections.cleanup.confirmDelete.title')"
    width="420px"
    :closable="false"
    :mask-closable="true"
    initial-focus="last"
    body-padding="compact"
    @close="emit('cancel')"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-warning" aria-hidden="true"></i>
        <h3>{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.title') }}</h3>
      </div>
    </template>

    <template v-if="state">
      <p class="dialog-title-text">{{ state.title }}</p>
      <p class="delete-stats">
        {{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.stats', {
          count: state.count,
          size: formatSize(state.size)
        }) }}
      </p>
      <p class="warning-text gc-feedback gc-feedback--warning">
        <i class="codicon codicon-warning" aria-hidden="true"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.warning') }}</span>
      </p>
    </template>

    <template v-if="state" #footer>
      <button type="button" class="gc-button dialog-btn cancel" @click="emit('cancel')">
        {{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.cancel') }}
      </button>
      <button
        type="button"
        class="gc-button danger-confirm dialog-btn confirm"
        :disabled="isBatchDeleting"
        @click="emit('confirm')"
      >
        {{ t('components.settings.checkpoint.sections.cleanup.confirmDelete.delete') }}
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
  color: var(--gc-warning);
  font-size: var(--gc-icon-size-lg);
}

.dialog-heading h3,
.dialog-title-text,
.delete-stats,
.warning-text {
  margin: 0;
}

.dialog-heading h3 {
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.dialog-title-text {
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-normal);
}

.delete-stats {
  margin-top: var(--gc-space-2);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
}

.warning-text {
  margin-top: var(--gc-space-3);
  font-weight: var(--gc-font-weight-medium);
}

.danger-confirm {
  color: var(--vscode-button-foreground, var(--gc-text-on-accent));
  background: var(--gc-danger);
}

.danger-confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gc-danger) 86%, var(--gc-text-primary));
}
</style>
