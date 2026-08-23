<script setup lang="ts">
/**
 * ImportModesDialog - 导入提示词模式对话框。
 * payload 与错误信息继续由父组件持有。
 */
import { ref } from 'vue'
import { t } from '@/i18n'
import { Modal } from '../../common'

defineProps<{
  payloadText: string
  errorMessage: string
}>()

const emit = defineEmits<{
  (event: 'update:payloadText', value: string): void
  (event: 'update:errorMessage', value: string): void
  (event: 'close'): void
  (event: 'confirm'): void
  (event: 'exportAll'): void
  (event: 'fileChange', file: Event): void
}>()

const fileInputRef = ref<HTMLInputElement | null>(null)

function triggerFilePicker() {
  fileInputRef.value?.click()
}
</script>

<template>
  <Modal
    :model-value="true"
    :aria-label="t('components.settings.promptSettings.modes.import')"
    aria-describedby="prompt-import-description"
    width="720px"
    initial-focus-selector=".import-textarea"
    body-padding="compact"
    @close="emit('close')"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-cloud-upload" aria-hidden="true"></i>
        <h3>{{ t('components.settings.promptSettings.modes.import') }}</h3>
      </div>
    </template>

    <div class="import-dialog-body">
      <p id="prompt-import-description" class="import-dialog-description">
        {{ t('components.settings.promptSettings.modes.importDescription') }}
      </p>
      <div class="import-dialog-toolbar">
        <button type="button" class="gc-button" @click="triggerFilePicker">
          <i class="codicon codicon-folder-opened" aria-hidden="true"></i>
          {{ t('components.settings.promptSettings.modes.importFromFile') }}
        </button>
        <button type="button" class="gc-button" @click="emit('exportAll')">
          <i class="codicon codicon-export" aria-hidden="true"></i>
          {{ t('components.settings.promptSettings.modes.exportAll') }}
        </button>
      </div>
      <input
        ref="fileInputRef"
        type="file"
        accept="application/json,.json"
        class="hidden-file-input"
        @change="(event: Event) => emit('fileChange', event)"
      />
      <textarea
        :value="payloadText"
        class="import-textarea gc-field"
        :placeholder="t('components.settings.promptSettings.modes.importPlaceholder')"
        :aria-invalid="!!errorMessage"
        :aria-describedby="errorMessage ? 'prompt-import-error' : 'prompt-import-description'"
        rows="12"
        @input="emit('update:payloadText', ($event.target as HTMLTextAreaElement).value)"
      ></textarea>
      <p
        v-if="errorMessage"
        id="prompt-import-error"
        class="import-error gc-feedback gc-feedback--error"
        role="alert"
      >
        <i class="codicon codicon-warning" aria-hidden="true"></i>
        <span>{{ errorMessage }}</span>
      </p>
    </div>

    <template #footer>
      <button type="button" class="gc-button" @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="gc-button gc-button--primary"
        :disabled="!payloadText.trim()"
        @click="emit('confirm')"
      >
        {{ t('components.settings.promptSettings.modes.importConfirm') }}
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
}

.dialog-heading h3 {
  margin: 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.import-dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-3);
  min-height: 0;
}

.import-dialog-description,
.import-error {
  margin: 0;
}

.import-dialog-description {
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
  line-height: var(--gc-line-height-normal);
}

.import-dialog-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gc-space-2);
}

.import-textarea {
  min-height: 260px;
  padding: var(--gc-space-3);
  resize: vertical;
  font-family: var(--vscode-editor-font-family, monospace);
  line-height: var(--gc-line-height-normal);
}

.hidden-file-input {
  display: none;
}
</style>
