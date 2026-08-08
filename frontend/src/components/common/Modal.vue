<script setup lang="ts">
/**
 * 通用模态框组件
 */

import { computed, watch, onMounted, onUnmounted } from 'vue'
import { lockBodyScroll, unlockBodyScroll } from '../../utils/bodyScrollLock'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  width?: string
  closable?: boolean
  maskClosable?: boolean
}>(), {
  width: '500px',
  closable: true,
  maskClosable: true
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  close: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

function close() {
  visible.value = false
  emit('close')
}

function handleMaskClick() {
  if (props.maskClosable) {
    close()
  }
}

function handleEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && visible.value && props.closable) {
    close()
  }
}

let ownsScrollLock = false
watch(visible, (val) => {
  if (val && !ownsScrollLock) {
    lockBodyScroll()
    ownsScrollLock = true
  } else if (!val && ownsScrollLock) {
    unlockBodyScroll()
    ownsScrollLock = false
  }
}, { immediate: true })

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc)
  if (ownsScrollLock) {
    unlockBodyScroll()
    ownsScrollLock = false
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="visible" class="modal-overlay" @click.self="handleMaskClick">
        <div class="modal" :style="{ width }" role="dialog" aria-modal="true" :aria-label="title || 'Dialog'">
          <!-- 头部 -->
          <div v-if="title || closable" class="modal-header">
            <h3 v-if="title" class="modal-title">{{ title }}</h3>
            <button v-if="closable" class="modal-close" @click="close">
              <i class="codicon codicon-close"></i>
            </button>
          </div>

          <!-- 内容 -->
          <div class="modal-body">
            <slot />
          </div>

          <!-- 底部 -->
          <div v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
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
  padding: 20px;
}

.modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 18px;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s;
}

.modal-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--vscode-panel-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

/* 动画 */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}

.modal-fade-enter-active .modal,
.modal-fade-leave-active .modal {
  transition: transform 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-from .modal,
.modal-fade-leave-to .modal {
  transform: scale(0.95);
}
</style>