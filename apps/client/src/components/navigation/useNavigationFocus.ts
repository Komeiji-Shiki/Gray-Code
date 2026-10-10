import { nextTick, onMounted, onUnmounted, watch, type Ref } from 'vue';

/** 菜单进入确认表单时保留同一个触发点，关闭后仍回到对应的导航操作。 */
export function useNavigationFocus(root: Readonly<Ref<HTMLElement | undefined>>, dismiss: () => void, fallback: () => HTMLElement | undefined) {
  let trigger: HTMLElement | undefined;
  let disposed = false;

  function rememberTrigger(event: MouseEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    trigger = target.matches('button') ? target : target.querySelector<HTMLElement>('.navigation-more, .navigation-project-more, button') ?? target;
  }

  function focusableElements(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('button, input, [tabindex]')).filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (node === container) break;
      }
      return true;
    });
  }

  function restoreFocus() {
    const target = trigger;
    trigger = undefined;
    const next = target?.isConnected ? target : fallback();
    if (next?.isConnected) next.focus();
  }

  watch(root, (current, previous) => {
    if (current) {
      // v-model 的 mounted 钩子先写入原名称，再选择文本。
      void nextTick(() => {
        if (disposed || root.value !== current) return;
        const input = current.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not(:disabled)');
        const target = input ?? current.querySelector<HTMLElement>('[data-navigation-cancel]:not(:disabled), [aria-checked="true"]:not(:disabled)') ?? focusableElements(current)[0] ?? current;
        target.focus();
        input?.select();
      });
    } else if (previous) {
      void nextTick(() => { if (!disposed && !root.value) restoreFocus(); });
    }
  }, { flush: 'post' });

  function handleKeydown(event: KeyboardEvent) {
    const container = root.value;
    if (!container || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss();
      return;
    }
    const menuNavigation = container.getAttribute('role') === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key);
    // 文本输入不参与焦点导航，避免每次按键都读取所有控件及其祖先的样式。
    if (event.key !== 'Tab' && !menuNavigation) return;
    const elements = focusableElements(container);
    const active = document.activeElement;
    if (event.key === 'Tab') {
      const first = elements[0]; const last = elements.at(-1);
      if (!first || !active || !container.contains(active) || active === container || event.shiftKey && active === first || !event.shiftKey && active === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        if (!first) container.focus();
      }
    } else if (menuNavigation && elements.length) {
      event.preventDefault();
      const index = elements.findIndex(element => element === active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? elements.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + elements.length) % elements.length;
      elements[next].focus();
    }
  }

  onMounted(() => document.addEventListener('keydown', handleKeydown));
  onUnmounted(() => { disposed = true; document.removeEventListener('keydown', handleKeydown); if (root.value) restoreFocus(); });
  return { rememberTrigger };
}
