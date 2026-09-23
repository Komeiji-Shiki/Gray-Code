import { afterEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChatError from '../ChatError.vue'

const originalHost = window.__GRAYCODE_HOST
const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand
afterEach(() => {
  window.__GRAYCODE_HOST = originalHost
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  vi.restoreAllMocks()
})
const global = { stubs: { CustomScrollbar: { template: '<div><slot /></div>' } } }

test('复制完整错误码和多行正文，成功后显示反馈并保留重试和关闭', async () => {
  const copy = vi.fn().mockResolvedValue(undefined)
  window.__GRAYCODE_HOST = { postMessage() {}, getState() {}, setState() {}, writeClipboardText: copy }
  const wrapper = mount(ChatError, { props: { error: { code: 'STREAM_ERROR', message: '请求失败\n服务端明细' } }, global })
  await wrapper.get('button[title="复制"]').trigger('click'); await flushPromises()
  expect(copy).toHaveBeenCalledWith('STREAM_ERROR: 请求失败\n服务端明细')
  expect(wrapper.get('[role="status"]').text()).toBe('已复制')
  await wrapper.get('.error-retry').trigger('click'); await wrapper.get('.error-dismiss').trigger('click')
  expect(wrapper.emitted('retry')).toHaveLength(1); expect(wrapper.emitted('dismiss')).toHaveLength(1)
  await wrapper.setProps({ error: { code: 'RESTORE_ERROR', message: '恢复失败' } })
  expect(wrapper.find('.error-retry').exists()).toBe(false)
  expect(wrapper.get('[role="status"]').text()).toBe('')
  wrapper.unmount()
})

test('剪贴板失败显示失败状态，保留原始错误正文', async () => {
  window.__GRAYCODE_HOST = undefined
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wrapper = mount(ChatError, { props: { error: { code: 'STREAM_ERROR', message: '原始错误' } }, global })
  await wrapper.get('button[title="复制"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe('复制失败')
  expect(wrapper.get('pre').text()).toBe('STREAM_ERROR: 原始错误')
  wrapper.unmount()
})
