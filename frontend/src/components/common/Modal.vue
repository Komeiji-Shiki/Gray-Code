<script setup lang="ts">
/**
 * 通用模态框组件
 */

import { computed, ref, watch, onMounted, onUnmounted, nextTick, getCurrentInstance } from 'vue'
import { t } from '@/i18n'
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

const instanceId = getCurrentInstance()?.uid ?? 0
const titleId = `gc-modal-title-${instanceId}`
const accessibleLabel = computed(() => props.title || t('common.dialog'))

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

// ==================== 焦点管理（可访问性） ====================
const modalRoot = ref<HTMLElement | null>(null)
/** 打开对话框前处于焦点的元素：关闭后归还焦点 */
let previouslyFocused: HTMLElement | null = null

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
}

function restoreFocus() {
  if (previouslyFocused && document.contains(previouslyFocused)) {
    previouslyFocused.focus()
  }
  previouslyFocused = null
}

// Esc 关闭 + Tab 焦点陷阱：焦点在对话框内循环；焦点逃逸到对话框外时拉回。
// 嵌套 Modal（如 ResponseViewerDialog → JsonViewerDialog）场景：仅当焦点位于本 Modal、
// 或不在任何其他 role="dialog" 内时才处理 Esc/Tab——焦点在更上层 Modal 中时本 Modal
// 直接放行，避免焦点陷阱互相劫持、Esc 一次关闭所有层（最上层 Modal 独自处理）。
function handleKeydown(e: KeyboardEvent) {
  const root = modalRoot.value
  if (!root) return
  const active = document.activeElement
  // 焦点位于其他（更上层）对话框内：本 Modal 不参与 Esc 关闭与 Tab 陷阱
  const inOtherDialog = !!active && !!active.closest?.('[role="dialog"]') && !root.contains(active)
  if (inOtherDialog) return
  if (!visible.value) return

  if (e.key === 'Escape' && props.closable) {
    close()
    return
  }
  if (e.key !== 'Tab') return
  const focusables = getFocusableElements(root)
  if (focusables.length === 0) {
    e.preventDefault()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const isInside = !!active && root.contains(active)
  if (e.shiftKey) {
    if (active === first || !isInside) {
      e.preventDefault()
      last.focus()
    }
  } else if (active === last || !isInside) {
    e.preventDefault()
    first.focus()
  }
}

let ownsScrollLock = false
watch(visible, (val) => {
  if (val && !ownsScrollLock) {
    lockBodyScroll()
    ownsScrollLock = true
    // 打开时记录触发元素并把焦点移入对话框（渲染完成后执行）
    previouslyFocused = document.activeElement as HTMLElement | null
    nextTick(() => {
      if (!visible.value) return
      const root = modalRoot.value
      if (!root) return
      const focusables = getFocusableElements(root)
      // root 带 tabindex="-1"：无任何可聚焦元素时（纯信息对话框）root.focus() 也能生效，
      // 焦点进入对话框内，Esc/Tab 继续由 handleKeydown 处理
      ;(focusables[0] || root).focus()
    })
  } else if (!val && ownsScrollLock) {
    unlockBodyScroll()
    ownsScrollLock = false
    restoreFocus()
  }
}, { immediate: true })

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (ownsScrollLock) {
    unlockBodyScroll()
    ownsScrollLock = false
  }
  // 对话框在打开状态下被销毁时也要归还焦点
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="visible" class="modal-overlay" @click.self="handleMaskClick">
        <div
          ref="modalRoot"
          class="modal"
          :style="{ width }"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :aria-labelledby="title ? titleId : undefined"
          :aria-label="title ? undefined : accessibleLabel"
        >
          <!-- 头部 -->
          <div v-if="title || closable" class="modal-header">
            <h3 v-if="title" :id="titleId" class="modal-title">{{ title }}</h3>
            <button
              v-if="closable"
              type="button"
              class="modal-close"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="close"
            >
              <i class="codicon codicon-close" aria-hidden="true"></i>
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
  background: color-mix(in srgb, #000 50%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--gc-layer-modal);
  padding: var(--gc-space-5);
}

.modal {
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-md);
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--gc-shadow-md);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--gc-space-4) var(--gc-space-5);
  border-bottom: 1px solid var(--gc-border-subtle);
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
  color: var(--gc-text-primary);
}

.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--gc-control-height-md);
  height: var(--gc-control-height-md);
  border: none;
  background: transparent;
  color: var(--gc-text-primary);
  font-size: var(--gc-icon-size-lg);
  cursor: pointer;
  border-radius: var(--gc-radius-sm);
  transition: background-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.modal-close:hover {
  background: var(--gc-surface-hover);
}

.modal-body {
  padding: var(--gc-space-5);
  overflow-y: auto;
  flex: 1;
}

.modal-footer {
  padding: var(--gc-space-4) var(--gc-space-5);
  border-top: 1px solid var(--gc-border-subtle);
  display: flex;
  justify-content: flex-end;
  gap: var(--gc-space-2);
  flex-shrink: 0;
}

/* 动画 */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--gc-duration-normal) var(--gc-ease-standard);
}

.modal-fade-enter-active .modal,
.modal-fade-leave-active .modal {
  transition: transform var(--gc-duration-normal) var(--gc-ease-emphasized);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-from .modal,
.modal-fade-leave-to .modal {
  transform: scale(0.97);
}

@media (prefers-reduced-motion: reduce) {
  .modal-fade-enter-active,
  .modal-fade-leave-active,
  .modal-fade-enter-active .modal,
  .modal-fade-leave-active .modal {
    transition: none;
  }
}

@media (forced-colors: active) {
  .modal {
    border-color: CanvasText;
  }
}
</style>