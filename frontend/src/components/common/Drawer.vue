<script setup lang="ts">
/**
 * 侧边抽屉组件
 */

import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { lockBodyScroll, unlockBodyScroll } from '../../utils/bodyScrollLock'
import { t } from '../../i18n'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  placement?: 'left' | 'right'
  width?: string
  closable?: boolean
  maskClosable?: boolean
}>(), {
  placement: 'right',
  width: '400px',
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

// 抽屉根节点：Esc 顶层判定需要知道焦点是否在本抽屉内
const drawerRoot = ref<HTMLElement | null>(null)

function handleEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const root = drawerRoot.value
  const active = document.activeElement
  // 与 Modal 同款顶层判定：焦点位于其他（更上层）role="dialog" 内时本 Drawer 不参与 Esc 关闭，
  // 避免 Modal 之上按 Esc 同时关闭两层（最上层对话框独自处理）
  const inOtherDialog = !!active && !!active.closest?.('[role="dialog"]') && !!root && !root.contains(active)
  if (inOtherDialog) return
  if (visible.value && props.closable) {
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
    <Transition name="drawer-fade">
      <div v-if="visible" class="drawer-overlay" @click.self="handleMaskClick">
        <Transition :name="`drawer-slide-${placement}`">
          <div
            v-if="visible"
            ref="drawerRoot"
            :class="['drawer', placement]"
            :style="{ width }"
            role="dialog"
            aria-modal="true"
            :aria-label="title || 'Drawer'"
          >
            <!-- 头部 -->
            <div v-if="title || closable" class="drawer-header">
              <h3 v-if="title" class="drawer-title">{{ title }}</h3>
              <button
                v-if="closable"
                type="button"
                class="drawer-close gc-icon-button"
                :title="t('common.close')"
                :aria-label="t('common.close')"
                @click="close"
              >
                <i class="codicon codicon-close" aria-hidden="true"></i>
              </button>
            </div>

            <!-- 内容 -->
            <div class="drawer-body">
              <slot />
            </div>

            <!-- 底部 -->
            <div v-if="$slots.footer" class="drawer-footer">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 扁平化抽屉设计 */
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1000;
}

.drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
}

.drawer.left {
  left: 0;
  border-left: none;
}

.drawer.right {
  right: 0;
  border-right: none;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md, 16px) var(--spacing-lg, 20px);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.drawer-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 16px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity var(--transition-fast, 0.1s);
}

.drawer-close:hover {
  opacity: 1;
}

.drawer-body {
  padding: var(--spacing-lg, 20px);
  overflow-y: auto;
  flex: 1;
}

.drawer-footer {
  padding: var(--spacing-md, 16px) var(--spacing-lg, 20px);
  border-top: 1px solid var(--vscode-panel-border);
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm, 8px);
  flex-shrink: 0;
}

/* 遮罩动画 */
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.15s ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

/* 抽屉滑动动画 - 右侧 */
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active {
  transition: transform 0.2s ease;
}

.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  transform: translateX(100%);
}

/* 抽屉滑动动画 - 左侧 */
.drawer-slide-left-enter-active,
.drawer-slide-left-leave-active {
  transition: transform 0.2s ease;
}

.drawer-slide-left-enter-from,
.drawer-slide-left-leave-to {
  transform: translateX(-100%);
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .drawer-fade-enter-active,
  .drawer-fade-leave-active,
  .drawer-slide-right-enter-active,
  .drawer-slide-right-leave-active,
  .drawer-slide-left-enter-active,
  .drawer-slide-left-leave-active {
    transition: none;
  }
}
</style>