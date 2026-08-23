<script setup lang="ts">
/**
 * ChannelCreateDialog - 新建渠道对话框。
 * 名称、类型与错误状态仍由父组件持有。
 */
import { CustomSelect, Modal, type SelectOption } from '../../common'
import { t } from '@/i18n'
import type { ChannelType } from '@/types'

defineProps<{
  show: boolean
  name: string
  type: ChannelType
  nameError: boolean
  typeOptions: SelectOption[]
}>()

const emit = defineEmits<{
  (e: 'update:name', value: string): void
  (e: 'update:type', value: ChannelType): void
  (e: 'create'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <Modal
    :model-value="show"
    :title="t('components.settings.channelSettings.dialog.new.title')"
    width="420px"
    initial-focus-selector=".config-name-input"
    body-padding="compact"
    @close="emit('cancel')"
  >
    <div class="dialog-content">
      <div class="form-group">
        <label for="channel-create-name">{{ t('components.settings.channelSettings.dialog.new.nameLabel') }}</label>
        <input
          id="channel-create-name"
          :value="name"
          type="text"
          class="config-name-input gc-field"
          :class="{ 'input-error': nameError }"
          :placeholder="t('components.settings.channelSettings.dialog.new.namePlaceholder')"
          :aria-invalid="nameError"
          :aria-describedby="nameError ? 'channel-create-name-error' : undefined"
          @keyup.enter="emit('create')"
          @input="emit('update:name', ($event.target as HTMLInputElement).value)"
        />
        <span
          v-if="nameError"
          id="channel-create-name-error"
          class="config-name-error"
          role="alert"
        >{{ t('components.settings.channelSettings.dialog.new.nameRequired') }}</span>
      </div>

      <div class="form-group">
        <label>{{ t('components.settings.channelSettings.dialog.new.typeLabel') }}</label>
        <CustomSelect
          :model-value="type"
          :options="typeOptions"
          :placeholder="t('components.settings.channelSettings.dialog.new.typePlaceholder')"
          :aria-label="t('components.settings.channelSettings.dialog.new.typeLabel')"
          @update:model-value="emit('update:type', $event as ChannelType)"
        />
      </div>
    </div>

    <template #footer>
      <button type="button" class="gc-button" @click="emit('cancel')">
        {{ t('components.settings.channelSettings.dialog.new.cancel') }}
      </button>
      <button type="button" class="gc-button gc-button--primary" @click="emit('create')">
        {{ t('components.settings.channelSettings.dialog.new.create') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-3);
}

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

.config-name-input.input-error {
  border-color: var(--vscode-inputValidation-errorBorder, var(--gc-danger));
}

.config-name-error {
  color: var(--vscode-inputValidation-errorForeground, var(--gc-danger));
  font-size: var(--gc-font-size-caption);
}
</style>
