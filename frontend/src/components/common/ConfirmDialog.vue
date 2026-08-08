<script setup lang="ts">
/**
 * 确认对话框组件
 * 参考 gemini-go-sandbox 样式
 */

import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../../i18n'

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

// 使用 i18n 默认值
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

const dialogRef = ref<HTMLElement | null>(null)
const confirmButtonRef = ref<HTMLButtonElement | null>(null)
let previouslyFocused: HTMLElement | null = null

watch(visible, async (shown) => {
  if (shown) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    confirmButtonRef.value?.focus()
  } else {
    previouslyFocused?.focus()
    previouslyFocused = null
  }
})

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    handleCancel()
    return
  }
  if (event.key !== 'Tab' || !dialogRef.value) return
  const focusables = Array.from(dialogRef.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'))
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const iconClass = computed(() => {
  return props.isDanger ? 'codicon-warning' : 'codicon-info'
})

const iconColor = computed(() => {
  return props.isDanger 
    ? 'var(--vscode-errorForeground)' 
    : 'var(--vscode-editorWarning-foreground)'
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="dialog-overlay" @click.self="handleCancel">
        <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" :aria-label="displayTitle" @keydown="handleKeydown">
          <div class="dialog-header">
            <i :class="['codicon', iconClass, 'dialog-icon']" :style="{ color: iconColor }"></i>
            <span class="dialog-title">{{ displayTitle }}</span>
          </div>
          <div class="dialog-body">
            <p v-if="displayMessage">{{ displayMessage }}</p>
            <!-- 扩展内容：恢复确认时展示待删除文件清单等 -->
            <slot />
          </div>
          <div class="dialog-footer">
            <button class="dialog-btn cancel" @click="handleCancel">
              {{ displayCancelText }}
            </button>
            <button ref="confirmButtonRef" :class="['dialog-btn', 'confirm', { 'danger': props.isDanger }]" @click="handleConfirm">
              {{ displayConfirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  min-width: 280px;
  max-width: 90%;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.dialog-icon {
  font-size: 18px;
}

.dialog-title {
  font-weight: 500;
  font-size: 14px;
}

.dialog-body {
  padding: 16px;
}

.dialog-body p {
  margin: 0;
  font-size: 13px;
  color: var(--vscode-foreground);
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.dialog-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: background-color 0.15s, opacity 0.15s;
}

.dialog-btn.cancel {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.dialog-btn.cancel:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.dialog-btn.confirm {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.confirm:hover {
  background: var(--vscode-button-hoverBackground);
}

.dialog-btn.confirm.danger {
  background: var(--vscode-errorForeground);
  color: var(--vscode-button-foreground, #fff);
}

.dialog-btn.confirm.danger:hover {
  opacity: 0.9;
}

/* 动画 */
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.15s ease;
}

.dialog-fade-enter-active .dialog,
.dialog-fade-leave-active .dialog {
  transition: transform 0.15s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-from .dialog,
.dialog-fade-leave-to .dialog {
  transform: scale(0.95);
}
</style>