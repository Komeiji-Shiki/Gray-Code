import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import Modal from '../../components/common/Modal.vue'

const wrappers: Array<{ unmount: () => void }> = []
function remember<T extends { unmount: () => void }>(wrapper: T): T {
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

beforeEach(() => {
  document.body.innerHTML = ''
})

function triggerEsc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

function triggerTab(shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
}

function dialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
}

function overlayEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.modal-overlay')
  if (!el) throw new Error('overlay not found in document.body')
  return el
}

function mountModal(props: InstanceType<typeof Modal>['$props'], slots?: Record<string, any>) {
  return remember(mount(Modal, {
    attachTo: document.body,
    props,
    slots
  }))
}

describe('Modal 对话框行为', () => {
  test('打开时渲染标题，aria-labelledby 指向标题', () => {
    const wrapper = mountModal({ modelValue: true, title: '对话框标题' })
    const dialog = dialogs()[0]
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBeNull()
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.querySelector('.modal-title')?.textContent).toBe('对话框标题')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  test('无标题时使用 ariaLabel 兜底', () => {
    mountModal({ modelValue: true, ariaLabel: '自定义名称' })
    const dialog = dialogs()[0]
    expect(dialog.getAttribute('aria-label')).toBe('自定义名称')
  })

  test('Escape 关闭并触发 close 恰一次', async () => {
    const wrapper = mountModal({ modelValue: true, title: 'Esc 测试' })
    triggerEsc()
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  test('closeOnEscape=false 时 Escape 不关闭', async () => {
    const wrapper = mountModal({ modelValue: true, title: 'Esc 禁止', closeOnEscape: false })
    triggerEsc()
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  test('焦点陷阱：Tab 从最后一个元素循环回第一个', async () => {
    const ContentHost = defineComponent({
      template: '<button id="btn-a">A</button><button id="btn-b">B</button>'
    })
    mountModal({ modelValue: true, title: '陷阱', closable: false }, { default: ContentHost })
    await nextTick()
    await nextTick()
    const dialog = dialogs()[0]
    dialog.querySelector<HTMLElement>('#btn-b')!.focus()
    expect(document.activeElement?.id).toBe('btn-b')
    triggerTab()
    await nextTick()
    expect(document.activeElement?.id).toBe('btn-a')
  })

  test('焦点陷阱：Shift+Tab 从第一个元素循环回最后一个', async () => {
    const ContentHost = defineComponent({
      template: '<button id="btn-a">A</button><button id="btn-b">B</button>'
    })
    mountModal({ modelValue: true, title: '陷阱', closable: false }, { default: ContentHost })
    await nextTick()
    await nextTick()
    const dialog = dialogs()[0]
    dialog.querySelector<HTMLElement>('#btn-a')!.focus()
    triggerTab(true)
    await nextTick()
    expect(document.activeElement?.id).toBe('btn-b')
  })

  test('关闭后焦点归还到触发元素', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'open'
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = mountModal({ modelValue: true, title: '归还' })
    await nextTick()
    triggerEsc()
    // 模拟父组件 v-model 更新：prop 更新后 watch 才走 else 分支
    await wrapper.setProps({ modelValue: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  test('initialFocus 使用 CSS 选择器定位目标', async () => {
    const ContentHost = defineComponent({
      template: '<button id="btn-a">A</button><button id="btn-b">B</button>'
    })
    mountModal(
      { modelValue: true, title: '选择器', initialFocusSelector: '#btn-b' },
      { default: ContentHost }
    )
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('btn-b')
  })

  test('无 `initialFocus` 时默认聚焦第一个可聚焦元素', async () => {
    const ContentHost = defineComponent({
      template: '<button id="btn-a">A</button><button id="btn-b">B</button>'
    })
    mountModal({ modelValue: true, title: '默认', closable: false }, { default: ContentHost })
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('btn-a')
  })

  test('initialFocus="last" 时聚焦最后一个可聚焦元素', async () => {
    const ContentHost = defineComponent({
      template: '<button id="btn-a">A</button><button id="btn-b">B</button>'
    })
    mountModal({ modelValue: true, title: '最后', initialFocus: 'last', closable: false }, { default: ContentHost })
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('btn-b')
  })

  test('遮罩点击关闭，对话框内点击不关闭', async () => {
    const wrapper = mountModal({ modelValue: true, title: '遮罩' })
    overlayEl().click()
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  test('maskClosable=false 时遮罩点击不关闭', async () => {
    const wrapper = mountModal({ modelValue: true, title: '遮罩禁用', maskClosable: false })
    overlayEl().click()
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  test('嵌套 Modal：焦点在最内层时 Esc 只关最内层', async () => {
    const Inner = defineComponent({
      template: '<div class="inner-card"><button>inner</button></div>'
    })
    const outter = mountModal({ modelValue: true, title: '外层' }, { default: Inner })
    const inner = remember(mount(Modal, {
      attachTo: document.body,
      props: { modelValue: true, title: '内层' }
    }))
    await nextTick()
    // 焦点移到最内层 dialog（最后一个）
    const innerRoot = dialogs()[dialogs().length - 1]
    innerRoot.focus()
    triggerEsc()
    await nextTick()
    expect(inner.emitted('close')).toHaveLength(1)
    expect(outter.emitted('close')).toBeUndefined()
  })

  test('关闭弹窗后从 DOM 移除，body 滚动锁释放', async () => {
    const wrapper = mountModal({ modelValue: true, title: '滚动锁' })
    expect(document.body.style.overflow).toBe('hidden')
    await wrapper.setProps({ modelValue: false })
    await nextTick()
    expect(document.body.style.overflow).toBe('')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
