<script setup lang="ts">
/** RenameSubAgentDialog - 重命名子代理对话框。 */
import { useI18n } from '@/i18n'
import { Modal } from '../../common'

defineProps<{
  editingName: string
  renameError: string
  onCancel: () => void
  onSave: () => void
}>()

const emit = defineEmits<{
  (e: 'update:editingName', value: string): void
}>()

const { t } = useI18n()

function onNameInput(event: Event) {
  emit('update:editingName', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <Modal
    :model-value="true"
    :title="t('components.settings.subagents.rename')"
    width="460px"
    initial-focus-selector=".agent-name-input"
    body-padding="compact"
    @close="onCancel"
  >
    <div class="form-group">
      <label for="subagent-rename-name">{{ t('components.settings.subagents.createDialog.nameLabel') }}</label>
      <input
        id="subagent-rename-name"
        :value="editingName"
        type="text"
        class="agent-name-input gc-field"
        :aria-invalid="!!renameError"
        :aria-describedby="renameError ? 'subagent-rename-error' : undefined"
        @input="onNameInput"
        @keyup.enter="onSave"
      />
    </div>

    <div
      v-if="renameError"
      id="subagent-rename-error"
      class="error-message gc-feedback gc-feedback--error"
      role="alert"
    >
      <i class="codicon codicon-error" aria-hidden="true"></i>
      <span>{{ renameError }}</span>
    </div>

    <template #footer>
      <button type="button" class="gc-button" @click="onCancel">
        {{ t('common.cancel') }}
      </button>
      <button type="button" class="gc-button gc-button--primary" @click="onSave">
        {{ t('common.save') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
}

.form-group label {
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-medium);
}

.error-message {
  margin-top: var(--gc-space-3);
}
</style>
