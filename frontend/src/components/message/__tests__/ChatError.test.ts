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

test('模型请求失败按类别给出处理办法：替代模型一键切换，密钥失效打开渠道设置，额度上限只提示', async () => {
  const wrapper = mount(ChatError, { props: { error: { code: 'API_ERROR',
    message: 'HTTP 410: Model deepseek-flash has been deprecated. Use deepseek-v4.1-flash instead.' } }, global })
  expect(wrapper.get('.error-advice-text').text()).toBe('模型已下线或当前不可用。')
  await wrapper.get('.error-advice-action').trigger('click')
  expect(wrapper.get('.error-advice-action').text()).toBe('改用 deepseek-v4.1-flash 并重试')
  expect(wrapper.emitted('switchModel')).toEqual([['deepseek-v4.1-flash']])
  await wrapper.setProps({ error: { code: 'API_ERROR', message: 'HTTP 401: Unauthorized' } })
  await wrapper.get('.error-advice-action').trigger('click')
  expect(wrapper.emitted('openChannelSettings')).toHaveLength(1)
  await wrapper.setProps({ error: { code: 'API_ERROR', message: 'HTTP 429: Go usage limit exceeded' } })
  expect(wrapper.get('.error-advice-text').text()).toContain('额度或调用频率已达上限')
  expect(wrapper.find('.error-advice-action').exists()).toBe(false)
  // 不可重试的界面操作错误即使文本相似也不附渠道动作。
  await wrapper.setProps({ error: { code: 'RESTORE_ERROR', message: 'HTTP 401: Unauthorized' } })
  expect(wrapper.find('.error-advice').exists()).toBe(false)
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
