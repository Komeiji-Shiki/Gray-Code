<script setup lang="ts">
import { getCurrentInstance, nextTick, ref } from 'vue'
import { IconButton, Tooltip } from '../common'
import { useDropdown } from '../../composables/useDropdown'
import { useI18n } from '../../i18n'

export interface InputActionItem {
  id: 'checkpoint' | 'summarize' | 'preview' | 'preserve-send'
  label: string
  title?: string
  icon: string
  disabled?: boolean
  loading?: boolean
}

defineProps<{ items: InputActionItem[] }>()
const emit = defineEmits<{ select: [id: InputActionItem['id']] }>()
const { t } = useI18n()
const containerRef = ref<HTMLElement>()
const menuRef = ref<HTMLElement>()
const menuId = `gc-input-actions-${getCurrentInstance()?.uid ?? 0}`
const { isOpen, close, toggle } = useDropdown(containerRef, {
  onOpen: () => { void nextTick(() => enabledItems()[0]?.focus()) }
})

function enabledItems(): HTMLButtonElement[] {
  return [...(menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
}

function closeAndRestoreFocus() {
  close()
  containerRef.value?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus()
}

function select(item: InputActionItem) {
  if (item.disabled || item.loading) return
  // 先恢复入口焦点，随后打开的弹窗才能接管焦点并在关闭后返回入口。
  closeAndRestoreFocus()
  emit('select', item.id)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    closeAndRestoreFocus()
    return
  }
  if (!isOpen.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      toggle()
      if (event.key === 'ArrowUp') void nextTick(() => enabledItems().at(-1)?.focus())
    }
    return
  }
  const items = enabledItems()
  if (!items.length) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'ArrowDown' ? (index + 1) % items.length
    : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
  if (next >= 0) {
    event.preventDefault()
    items[next]?.focus()
  }
}

function handleFocusOut(event: FocusEvent) {
  if (!containerRef.value?.contains(event.relatedTarget as Node | null)) close()
}
</script>

<template>
  <div ref="containerRef" class="input-actions-menu" @keydown="handleKeydown" @focusout="handleFocusOut">
    <Tooltip :content="t('desktop.inputUi.moreActions')" placement="top-left">
      <IconButton
        icon="codicon-ellipsis"
        size="small"
        :tooltip="t('desktop.inputUi.moreActions')"
        :aria-label="t('desktop.inputUi.moreActions')"
        aria-haspopup="menu"
        :aria-expanded="isOpen"
        :aria-controls="isOpen ? menuId : undefined"
        @click="toggle"
      />
    </Tooltip>
    <div v-if="isOpen" :id="menuId" ref="menuRef" class="input-actions-panel" role="menu" :aria-label="t('desktop.inputUi.moreActions')">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        :disabled="item.disabled || item.loading"
        :title="item.title || item.label"
        :aria-label="item.title || item.label"
        :aria-busy="item.loading || undefined"
        @click="select(item)"
      >
        <i :class="['codicon', item.loading ? 'codicon-loading codicon-modifier-spin' : item.icon]" aria-hidden="true"></i>
        <span>{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.input-actions-menu {
  display: inline-flex;
}

.input-actions-panel {
  /* 与固定文件、技能面板共用输入区定位，窄侧栏中也不会超出右边缘。 */
  position: absolute;
  bottom: calc(100% + var(--gc-space-2));
  left: var(--gc-space-2);
  z-index: var(--gc-layer-popover);
  width: max-content;
  max-width: min(300px, calc(100% - var(--gc-space-4)));
  padding: var(--gc-space-1);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-raised);
  box-shadow: var(--gc-shadow-sm);
}

.input-actions-panel button {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  width: 100%;
  min-height: var(--gc-control-height-md);
  padding: var(--gc-space-2);
  border: 0;
  border-radius: var(--gc-radius-xs);
  color: var(--gc-text-primary);
  background: transparent;
  font: inherit;
  font-size: var(--gc-font-size-caption);
  text-align: left;
  cursor: pointer;
}

.input-actions-panel button:hover:not(:disabled),
.input-actions-panel button:focus-visible {
  background: var(--gc-surface-hover);
}

.input-actions-panel button:focus-visible {
  outline: 1px solid var(--gc-focus-border);
  outline-offset: -1px;
}

.input-actions-panel button:disabled {
  color: var(--gc-text-muted);
  opacity: var(--gc-opacity-disabled);
  cursor: not-allowed;
}

.input-actions-panel .codicon {
  flex-shrink: 0;
}
</style>
