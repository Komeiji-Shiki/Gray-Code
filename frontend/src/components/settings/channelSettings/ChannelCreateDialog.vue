<script setup lang="ts">
/**
 * ChannelCreateDialog - 新建渠道对话框
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：名称 / 类型 / 错误状态由父组件注入，自身不持有业务状态。
 */
import { CustomSelect, type SelectOption } from '../../common'
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
  <div v-if="show" class="config-dialog" @click="emit('cancel')">
    <div class="dialog-content" @click.stop>
      <h4>{{ t('components.settings.channelSettings.dialog.new.title') }}</h4>

      <div class="form-group">
        <label>{{ t('components.settings.channelSettings.dialog.new.nameLabel') }}</label>
        <input
          :value="name"
          type="text"
          class="config-name-input"
          :class="{ 'input-error': nameError }"
          :placeholder="t('components.settings.channelSettings.dialog.new.namePlaceholder')"
          @keyup.enter="emit('create')"
          @input="emit('update:name', ($event.target as HTMLInputElement).value)"
        />
        <span v-if="nameError" class="config-name-error">{{ t('components.settings.channelSettings.dialog.new.nameRequired') }}</span>
      </div>

      <div class="form-group">
        <label>{{ t('components.settings.channelSettings.dialog.new.typeLabel') }}</label>
        <CustomSelect
          :model-value="type"
          :options="typeOptions"
          :placeholder="t('components.settings.channelSettings.dialog.new.typePlaceholder')"
          @update:model-value="emit('update:type', $event as ChannelType)"
        />
      </div>

      <div class="dialog-actions">
        <button class="btn secondary" @click="emit('cancel')">{{ t('components.settings.channelSettings.dialog.new.cancel') }}</button>
        <button class="btn primary" @click="emit('create')">{{ t('components.settings.channelSettings.dialog.new.create') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-dialog {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  padding: 0;
}

.dialog-content {
  width: 100%;
  max-width: 420px;
  margin: 16px;
  padding: 16px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.dialog-content h4 {
  margin: 0 0 16px 0;
  font-size: 13px;
  font-weight: 500;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.config-name-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
}

input[type="text"].config-name-input.input-error {
  border-color: var(--vscode-inputValidation-errorBorder);
}

.config-name-error {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--vscode-inputValidation-errorBorder);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.btn {
  padding: 6px 12px;
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
}

.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn.primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
</style>
