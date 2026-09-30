import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defineComponent, h, ref, type Ref } from 'vue'
import PlatformSettingsFooter from '../PlatformSettingsFooter.vue'
import SettingsSearchBox from '../panel/SettingsSearchBox.vue'
import { useSettingsFocus } from '../panel/useSettingsFocus'
import { desktopSettingsDraft as draft } from '../../../platform/settingsDraft'

const mocks = vi.hoisted(() => ({ send: vi.fn(), flush: vi.fn(), save: vi.fn(), discard: vi.fn() }))
vi.mock('../../../utils/vscode', () => ({ sendToExtension: mocks.send }))
vi.mock('../../../platform/settingsDraft', async () => {
  const { reactive } = await import('vue')
  return { desktopSettingsDraft: reactive({ dirty: false, busy: false, error: '' }),
    flushDesktopSettings: mocks.flush, saveDesktopSettings: mocks.save, discardDesktopSettings: mocks.discard }
})

const wrappers: ReturnType<typeof mount>[] = []
let visible: Ref<boolean>
let opener: HTMLButtonElement
let footer: InstanceType<typeof PlatformSettingsFooter>

beforeEach(() => {
  document.body.innerHTML = '<button id="settings-opener">设置</button>'
  opener = document.getElementById('settings-opener') as HTMLButtonElement
  opener.focus()
  Object.assign(draft, { dirty: false, busy: false, error: '' })
  mocks.send.mockReset(); mocks.flush.mockReset(); mocks.save.mockReset(); mocks.discard.mockReset()
  mocks.send.mockImplementation(async type => type === 'ui.settings.status' ? { dirty: draft.dirty } : {})
  mocks.flush.mockResolvedValue(undefined); mocks.save.mockResolvedValue(undefined); mocks.discard.mockResolvedValue(undefined)
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = '' })

async function openSettings(withSearch = false) {
  const wrapper = mount(defineComponent({ setup() {
    const root = ref<HTMLElement>()
    const footerRef = ref<InstanceType<typeof PlatformSettingsFooter>>()
    const query = ref('')
    const searchFocused = ref(false)
    visible = ref(true)
    useSettingsFocus(root, () => visible.value, () => { void footerRef.value?.requestClose() })
    return () => h('section', { ref: root, tabindex: -1, role: 'dialog', style: { display: visible.value ? '' : 'none' } }, [
      withSearch ? h(SettingsSearchBox, { query: query.value, focused: searchFocused.value, activeIndex: 0,
        searchActive: !!query.value, results: [], tabIcon: () => '',
        'onUpdate:query': value => { query.value = value },
        'onUpdate:focused': value => { searchFocused.value = value },
      }) : h('input', { id: 'first-field' }),
      h('button', { id: 'close-settings', onClick: () => footerRef.value?.requestClose() }, '返回'),
      h('button', { disabled: true }, '不可用'),
      h('div', { hidden: true }, [h('button', {}, '隐藏')]),
      h(PlatformSettingsFooter, { ref: footerRef, onClose: () => { visible.value = false } }),
    ])
  } }), { attachTo: document.body })
  wrappers.push(wrapper); await flushPromises()
  footer = wrapper.getComponent(PlatformSettingsFooter).vm
  return wrapper
}
function key(key: string, shiftKey = false) {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
}
function confirmation() { return document.querySelector<HTMLElement>('.modal[role="dialog"]') }

test('设置页每次进入都有焦点，Tab 和 Shift+Tab 循环时跳过隐藏与禁用控件', async () => {
  const wrapper = await openSettings()
  expect(document.activeElement).toBe(wrapper.element)
  key('Tab'); expect(document.activeElement?.id).toBe('first-field')
  key('Tab', true); expect(document.activeElement).toBe(wrapper.get('.platform-settings-footer button.primary').element)
  key('Tab'); expect(document.activeElement?.id).toBe('first-field')
  visible.value = false; await flushPromises(); expect(document.activeElement).toBe(opener)
  visible.value = true; await flushPromises(); expect(document.activeElement).toBe(wrapper.element)
})

test('无未保存草稿时 Escape 走退出流程并恢复入口焦点', async () => {
  await openSettings(); key('Escape'); await flushPromises()
  expect(visible.value).toBe(false)
  expect(mocks.send).toHaveBeenCalledWith('ui.settings.end', {})
  expect(document.activeElement).toBe(opener)
})

test('真实搜索框获得 Tab 焦点后，空查询 Escape 仍退出设置并恢复入口', async () => {
  const wrapper = await openSettings(true)
  key('Tab'); await flushPromises()
  expect(document.activeElement).toBe(wrapper.get('.settings-search-box input').element)
  key('Escape'); await flushPromises()
  expect(visible.value).toBe(false)
  expect(mocks.send).toHaveBeenCalledWith('ui.settings.end', {})
  expect(document.activeElement).toBe(opener)
})

test('搜索框的第一次 Escape 清空查询，第二次 Escape 退出设置', async () => {
  const wrapper = await openSettings(true)
  key('Tab'); await flushPromises()
  await wrapper.get('.settings-search-box input').setValue('model')
  key('Escape'); await flushPromises()
  expect(visible.value).toBe(true)
  expect(wrapper.get<HTMLInputElement>('.settings-search-box input').element.value).toBe('')
  expect(mocks.send).not.toHaveBeenCalledWith('ui.settings.end', {})
  key('Escape'); await flushPromises()
  expect(visible.value).toBe(false)
  expect(document.activeElement).toBe(opener)
})

test('未保存确认选择继续编辑，Tab 在确认内循环，Escape 只退出确认层', async () => {
  const wrapper = await openSettings(); draft.dirty = true
  const close = wrapper.get<HTMLButtonElement>('#close-settings').element
  close.focus(); await footer.requestClose(); await flushPromises()
  expect(document.activeElement).toBe(confirmation()!.querySelector('[data-continue-editing]'))
  const buttons = Array.from(confirmation()!.querySelectorAll<HTMLButtonElement>('button'))
  buttons.at(-1)!.focus(); key('Tab'); expect(document.activeElement).toBe(buttons[0])
  key('Tab', true); expect(document.activeElement).toBe(buttons.at(-1))
  key('Escape'); await flushPromises()
  expect(confirmation()).toBeNull(); expect(visible.value).toBe(true); expect(document.activeElement).toBe(close)
})

test('保存失败保留确认与错误，重试保存返回时恢复最初入口', async () => {
  await openSettings(); draft.dirty = true
  mocks.save.mockRejectedValueOnce(new Error('暂时无法保存'))
  await footer.requestClose(); await flushPromises()
  confirmation()!.querySelector<HTMLButtonElement>('button:last-child')!.click(); await flushPromises()
  expect(confirmation()!.querySelector('[role="alert"]')?.textContent).toBe('暂时无法保存')
  expect(visible.value).toBe(true)
  confirmation()!.querySelector<HTMLButtonElement>('button:last-child')!.click(); await flushPromises()
  expect(confirmation()).toBeNull(); expect(visible.value).toBe(false); expect(document.activeElement).toBe(opener)
})

test('处理中 Escape 不关闭确认，放弃返回仍执行原有草稿退出动作', async () => {
  await openSettings(); draft.dirty = true
  await footer.requestClose(); await flushPromises()
  draft.busy = true; await flushPromises(); key('Escape'); await flushPromises()
  expect(confirmation()).not.toBeNull(); expect(visible.value).toBe(true)
  draft.busy = false; await flushPromises()
  confirmation()!.querySelectorAll<HTMLButtonElement>('button')[1].click(); await flushPromises()
  expect(mocks.discard).toHaveBeenCalledOnce(); expect(visible.value).toBe(false); expect(document.activeElement).toBe(opener)
})
