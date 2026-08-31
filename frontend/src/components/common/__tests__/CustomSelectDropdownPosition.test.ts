/**
 * CustomSelect 选项面板定位测试
 *
 * 修改原因：面板原先是 absolute 挂在触发器下面，Modal 的 modal-body（overflow-y: auto）
 * 会把它裁掉，新建渠道这类矮对话框里下拉展开后完全选不到项。
 * 修改方式：面板 Teleport 到 body + position: fixed，按触发器视口矩形算位置，
 * 下方空间不足时自动朝上展开；这里覆盖方向判定、视口落位与事件边界。
 * 修改目的：回归保护「对话框内的下拉不再被裁」以及「Esc / 点击面板内部不会误关浮层」。
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CustomSelect from '../CustomSelect.vue'
import type { SelectOption } from '../types'

const options: SelectOption[] = [
  { value: 'gemini', label: 'Gemini API', description: 'Google Gemini' },
  { value: 'openai', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' }
]

const mountedWrappers: Array<{ unmount: () => void }> = []

/** 用假矩形替代 jsdom 的全零矩形：视口 1024x768，把触发器摆到指定位置 */
function stubTriggerRect(element: Element, top: number, height = 24, left = 100, width = 200) {
  element.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  }) as DOMRect
}

async function mountOpened(props: Record<string, unknown> = {}) {
  const wrapper = mount(CustomSelect, {
    attachTo: document.body,
    props: { modelValue: 'gemini', options, ...props }
  })
  mountedWrappers.push(wrapper)
  const trigger = wrapper.get('.select-trigger')
  stubTriggerRect(trigger.element, 700)
  await trigger.trigger('click')
  // open() 内 nextTick 才写面板样式，这里多等一帧让样式落地
  await nextTick()
  await nextTick()
  return { wrapper, trigger }
}

afterEach(() => {
  while (mountedWrappers.length > 0) mountedWrappers.pop()?.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('CustomSelect 面板定位', () => {
  test('面板挂到 body 上，不再位于触发器子树内', async () => {
    const { wrapper } = await mountOpened()
    const panel = document.body.querySelector('.select-dropdown')

    expect(panel).not.toBeNull()
    expect(wrapper.element.contains(panel)).toBe(false)
    expect(wrapper.find('.select-dropdown').exists()).toBe(false)
  })

  test('触发器贴近视口底部时面板朝上展开，并用 bottom 定位', async () => {
    const { trigger } = await mountOpened()
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')

    expect(panel).not.toBeNull()
    expect(panel!.classList.contains('is-drop-up')).toBe(true)
    expect(panel!.classList.contains('select-dropdown')).toBe(true)
    // 视口高 768、触发器 top 700 → bottom = 768 - 700 + 4
    expect(panel!.style.bottom).toBe('72px')
    expect(panel!.style.top).toBe('auto')
    expect(panel!.style.width).toBe('200px')
    // 展开方向翻转后焦点仍交还给触发器
    expect(trigger.attributes('aria-expanded')).toBe('true')
  })

  test('下方空间充足时面板朝下展开，列表高度不超过既定上限', async () => {
    const wrapper = mount(CustomSelect, {
      attachTo: document.body,
      props: { modelValue: 'gemini', options }
    })
    mountedWrappers.push(wrapper)
    stubTriggerRect(wrapper.get('.select-trigger').element, 100)
    await wrapper.get('.select-trigger').trigger('click')
    await nextTick()
    await nextTick()

    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')
    expect(panel!.classList.contains('is-drop-up')).toBe(false)
    // top = 触发器 bottom 124 + 间距 4
    expect(panel!.style.top).toBe('128px')
    expect(panel!.style.bottom).toBe('auto')
    expect(panel!.style.maxHeight).toBe('200px')
  })

  test('面板左边缘被约束在视口内，右边贴边时整体左移', async () => {
    const wrapper = mount(CustomSelect, {
      attachTo: document.body,
      props: { modelValue: 'gemini', options }
    })
    mountedWrappers.push(wrapper)
    // left 900 + width 200 = 1100，超出视口宽 1024
    stubTriggerRect(wrapper.get('.select-trigger').element, 100, 24, 900, 200)
    await wrapper.get('.select-trigger').trigger('click')
    await nextTick()
    await nextTick()

    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')
    expect(panel!.style.left).toBe('816px')
  })

  test('searchable 面板把搜索框高度计入总高', async () => {
    const { wrapper } = await mountOpened({ searchable: true })
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')

    expect(panel!.querySelector('.search-input')).not.toBeNull()
    // 朝上展开时剩余空间很大，列表取满 200，再加搜索行 40
    expect(panel!.style.maxHeight).toBe('240px')
    void wrapper
  })
})

describe('CustomSelect 事件边界', () => {
  test('点击面板内部不关闭，点击面板外才关闭', async () => {
    const { wrapper } = await mountOpened()
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')!

    // 点面板自身（例如滚动条区域）不算点外面，浮层保持打开
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('.select-dropdown')).not.toBeNull()

    const items = panel.querySelectorAll<HTMLElement>('.option-item')
    items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    // 选中后收起并回传新值
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['openai'])
    expect(document.body.querySelector('.select-dropdown')).toBeNull()

    await wrapper.get('.select-trigger').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.body.querySelector('.select-dropdown')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('.select-dropdown')).toBeNull()
  })

  test('浮层打开时 Esc 只收浮层，不冒泡到对话框', async () => {
    const onDocumentKeydown = vi.fn()
    document.addEventListener('keydown', onDocumentKeydown)
    const { wrapper } = await mountOpened()
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')!

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(document.body.querySelector('.select-dropdown')).toBeNull()
    expect(onDocumentKeydown).not.toHaveBeenCalled()
    // Esc 由浮层消费后焦点回到触发器
    expect(document.activeElement).toBe(wrapper.get('.select-trigger').element)
    document.removeEventListener('keydown', onDocumentKeydown)
  })

  test('键盘方向键在面板内的搜索框上同样可用', async () => {
    const { wrapper } = await mountOpened({ searchable: true })
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')!
    const searchInput = panel.querySelector<HTMLInputElement>('.search-input')!

    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    expect(panel.querySelectorAll('.option-item')[1].classList.contains('highlighted')).toBe(true)

    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['openai'])
  })

  test('宿主容器滚动时面板重新定位', async () => {
    const { wrapper, trigger } = await mountOpened()
    const panel = document.body.querySelector<HTMLElement>('.select-dropdown')!
    expect(panel.style.bottom).toBe('72px')

    stubTriggerRect(trigger.element, 400)
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    await nextTick()

    // 触发器上移后改为朝下展开：top = 424 + 4
    const moved = document.body.querySelector<HTMLElement>('.select-dropdown')!
    expect(moved.style.top).toBe('428px')
    void wrapper
  })
})
