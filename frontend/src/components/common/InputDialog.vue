<script setup lang="ts">
/**
 * 输入对话框组件，用于获取用户文本输入（替代原生 prompt）。
 */

import { ref, computed, watch, nextTick } from 'vue'
import { t } from '../../i18n'
import Modal from './Modal.vue'

interface Props {
  modelValue?: boolean
  title?: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  title: '',
  placeholder: '',
  defaultValue: '',
  confirmText: '',
  cancelText: ''
})

const displayTitle = computed(() => props.title || t('components.common.inputDialog.title'))
const displayConfirmText = computed(() => props.confirmText || t('components.common.inputDialog.confirm'))
const displayCancelText = computed(() => props.cancelText || t('components.common.inputDialog.cancel'))

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [value: string]
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const inputValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

watch(visible, (newValue) => {
  if (!newValue) return
  inputValue.value = props.defaultValue
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
})

function handleCancel() {
  visible.value = false
  emit('cancel')
}

function handleConfirm() {
  const value = inputValue.value.trim()
  if (!value) return
  visible.value = false
  emit('confirm', value)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  event.preventDefault()
  handleConfirm()
}
</script>

<template>
  <Modal
    v-model="visible"
    :title="displayTitle"
    width="400px"
    initial-focus-selector=".dialog-input"
    body-padding="compact"
    @close="handleCancel"
  >
    <input
      ref="inputRef"
      v-model="inputValue"
      type="text"
      class="dialog-input gc-field"
      :placeholder="placeholder"
      @keydown="handleKeydown"
    />

    <template #footer>
      <button type="button" class="gc-button" @click="handleCancel">
        {{ displayCancelText }}
      </button>
      <button
        type="button"
        class="gc-button gc-button--primary"
        :disabled="!inputValue.trim()"
        @click="handleConfirm"
      >
        {{ displayConfirmText }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-input {
  display: block;
}
</style>
