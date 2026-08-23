import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useDropdown, type UseDropdownOptions } from './useDropdown'

export interface UseSearchableDropdownParams<T> {
  items: Ref<T[]> | (() => T[])
  getKey: (item: T) => string
  disabled?: UseDropdownOptions['disabled']
  selectedKey?: Ref<string | undefined> | (() => string | undefined)
  filter?: (item: T, query: string) => boolean
}

function resolveValue<T>(v: Ref<T> | (() => T) | undefined, fallback: T): T {
  if (!v) return fallback
  return typeof v === 'function' ? (v as any)() : v.value
}

/**
 * Shared behavior for searchable dropdowns (channel/model/mode...)
 * - open/close/toggle + click-outside
 * - searchQuery + filteredItems
 * - highlightedIndex + keyboard navigation
 */
export function useSearchableDropdown<T>(containerRef: Ref<HTMLElement | undefined>, params: UseSearchableDropdownParams<T>) {
  const searchQuery = ref('')
  const highlightedIndex = ref(-1)
  const inputRef = ref<HTMLInputElement>()
  const triggerRef = ref<HTMLButtonElement>()
  // 打开后的 focus 定时器：保存句柄以便关闭/卸载时清除
  let focusTimer: ReturnType<typeof setTimeout> | null = null

  const { isOpen, open, close, toggle } = useDropdown(containerRef, {
    disabled: params.disabled,
    onOpen: () => {
      searchQuery.value = ''

      const items = resolveValue(params.items, [] as unknown as T[])
      const selected = resolveValue(params.selectedKey as any, undefined)
      const idx = selected ? items.findIndex(it => params.getKey(it) === selected) : -1
      highlightedIndex.value = idx >= 0 ? idx : (items.length > 0 ? 0 : -1)

      focusTimer = setTimeout(() => inputRef.value?.focus(), 10)
    },
    onClose: () => {
      searchQuery.value = ''
      highlightedIndex.value = -1
      if (focusTimer) {
        clearTimeout(focusTimer)
        focusTimer = null
      }
    }
  })

  // 卸载时清除未触发的 focus 定时器，避免组件销毁后仍尝试聚焦
  onBeforeUnmount(() => {
    if (focusTimer) {
      clearTimeout(focusTimer)
      focusTimer = null
    }
  })

  const filteredItems = computed(() => {
    const items = resolveValue(params.items, [] as unknown as T[])
    const q = (searchQuery.value || '').trim().toLowerCase()
    if (!q) return items

    if (params.filter) {
      return items.filter(it => params.filter!(it, q))
    }

    return items.filter(it => params.getKey(it).toLowerCase().includes(q))
  })

  watch(searchQuery, () => {
    highlightedIndex.value = filteredItems.value.length > 0 ? 0 : -1
  })

  function closeAndRestoreFocus() {
    close()
    queueMicrotask(() => triggerRef.value?.focus())
  }

  function selectHighlighted(): T | null {
    if (highlightedIndex.value < 0 || highlightedIndex.value >= filteredItems.value.length) return null
    return filteredItems.value[highlightedIndex.value]
  }

  function handleKeydown(event: KeyboardEvent, onSelect: (item: T) => void) {
    if (!isOpen.value) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault()
        open()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        highlightedIndex.value = Math.min(highlightedIndex.value + 1, filteredItems.value.length - 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0)
        break
      case 'Enter': {
        event.preventDefault()
        const item = selectHighlighted()
        if (item) onSelect(item)
        break
      }
      case 'Escape':
        event.preventDefault()
        closeAndRestoreFocus()
        break
    }
  }

  return {
    isOpen,
    open,
    close,
    toggle,

    inputRef,
    triggerRef,
    searchQuery,
    filteredItems,

    closeAndRestoreFocus,
    highlightedIndex,
    handleKeydown
  }
}
