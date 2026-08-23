<script setup lang="ts">
/**
 * 确认对话框组件。
 * 遮罩、焦点陷阱、Escape、滚动锁与焦点归还统一由 Modal 负责。
 */

import { computed } from 'vue'
import { t } from '../../i18n'
import Modal from './Modal.vue'

interface Props {
  modelValue?: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  isDanger?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  isDanger: false
})

const displayTitle = computed(() => props.title || t('components.common.confirmDialog.title'))
const displayMessage = computed(() => props.message || t('components.common.confirmDialog.message'))
const displayConfirmText = computed(() => props.confirmText || t('components.common.confirmDialog.confirm'))
const displayCancelText = computed(() => props.cancelText || t('components.common.confirmDialog.cancel'))

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

function handleConfirm() {
  visible.value = false
  emit('confirm')
}

function handleCancel() {
  visible.value = false
  emit('cancel')
}

const iconClass = computed(() => props.isDanger ? 'codicon-warning' : 'codicon-info')
</script>

<template>
  <Modal
    v-model="visible"
    :aria-label="displayTitle"
    width="420px"
    :closable="false"
    :mask-closable="true"
    initial-focus="last"
    body-padding="compact"
    @close="handleCancel"
  >
    <template #header>
      <div class="dialog-heading">
        <i
          :class="['codicon', iconClass, 'dialog-icon', { danger: props.isDanger }]"
          aria-hidden="true"
        ></i>
        <h3>{{ displayTitle }}</h3>
      </div>
    </template>

    <p v-if="displayMessage" class="dialog-message">{{ displayMessage }}</p>
    <slot />

    <template #footer>
      <button type="button" class="gc-button dialog-btn cancel" @click="handleCancel">
        {{ displayCancelText }}
      </button>
      <button
        type="button"
        :class="['gc-button', 'dialog-btn', 'confirm', props.isDanger ? 'danger-confirm' : 'gc-button--primary']"
        @click="handleConfirm"
      >
        {{ displayConfirmText }}
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

.dialog-heading h3 {
  margin: 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.dialog-icon {
  flex-shrink: 0;
  color: var(--gc-warning);
  font-size: var(--gc-icon-size-lg);
}

.dialog-icon.danger {
  color: var(--gc-danger);
}

.dialog-message {
  margin: 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-normal);
}

.danger-confirm {
  color: var(--vscode-button-foreground, var(--gc-text-on-accent));
  background: var(--gc-danger);
}

.danger-confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gc-danger) 86%, var(--gc-text-primary));
}
</style>
