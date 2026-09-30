import { nextTick, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { isTopModal, pushModal, removeModal } from '@/utils/modalStack'

/** 设置页由 v-show 保活，进入与返回都要按可见状态管理焦点。 */
export function useSettingsFocus(root: Ref<HTMLElement | undefined>, active: () => boolean, close: () => void) {
  const id = Symbol('settings')
  let previousFocus: HTMLElement | null = null
  let disposed = false

  function focusableElements(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]')).filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
      const closedDetails = element.closest('details:not([open])')
      if (closedDetails && element !== closedDetails.querySelector('summary')) return false
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (node === container) break
      }
      return true
    })
  }

  function restoreFocus() {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    previousFocus = null
  }

  watch(active, visible => {
    if (visible) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      pushModal(id)
      void nextTick(() => { if (!disposed && active() && isTopModal(id)) root.value?.focus({ preventScroll: true }) })
    } else {
      const wasTop = isTopModal(id)
      removeModal(id)
      if (wasTop) void nextTick(() => { if (!disposed && !active()) restoreFocus() })
      else previousFocus = null
    }
  }, { immediate: true, flush: 'sync' })

  function handleKeydown(event: KeyboardEvent) {
    const container = root.value
    if (!container || !active() || !isTopModal(id) || event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusableElements(container)
    const first = elements[0]
    const last = elements.at(-1)
    const focused = document.activeElement
    if (!first || !focused || !container.contains(focused) || focused === container || event.shiftKey && focused === first || !event.shiftKey && focused === last) {
      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus()
      if (!first) container.focus()
    }
  }

  onMounted(() => document.addEventListener('keydown', handleKeydown))
  onUnmounted(() => {
    disposed = true
    const wasTop = isTopModal(id)
    removeModal(id)
    document.removeEventListener('keydown', handleKeydown)
    if (wasTop) restoreFocus()
  })
}
