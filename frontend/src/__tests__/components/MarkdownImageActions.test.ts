import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import MarkdownRenderer from '../../components/common/MarkdownRenderer.vue'
import { invalidateWorkspaceAssets } from '../../components/common/markdown/markdownItCore'
import { sendToExtension, showNotification } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), showNotification: vi.fn() }))
const request = vi.mocked(sendToExtension), wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => {
  invalidateWorkspaceAssets(); vi.clearAllMocks(); vi.useFakeTimers()
  request.mockImplementation(async method => method === 'readWorkspaceImage' ? { success: true, mimeType: 'image/png', data: 'AAAA' } : { results: {} })
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })
async function render(content: string) {
  const wrapper = mount(MarkdownRenderer, { props: { content } }); wrappers.push(wrapper)
  await vi.advanceTimersByTimeAsync(0); await flushPromises(); request.mockClear()
  return wrapper
}

test('内嵌图片加载后原文件消失，打开失败会显示原因', async () => {
  const wrapper = await render('![图片](missing.png)')
  request.mockRejectedValueOnce(new Error('图片已被移动'))
  await wrapper.get('img.loaded-image').trigger('click'); await flushPromises()
  expect(showNotification).toHaveBeenCalledWith('图片已被移动', 'error')
  expect(wrapper.find('.markdown-content').exists()).toBe(true)
})

test('链接内的图片沿用链接目标，不额外打开本地图片', async () => {
  const wrapper = await render('[![图片](local.png)](https://example.com/page)')
  // 在组件处理之后阻止 jsdom 真正导航，保留前面处理器看到的事件状态。
  wrapper.element.addEventListener('click', (event: Event) => event.preventDefault(), { once: true })
  await wrapper.get('img.loaded-image').trigger('click'); await flushPromises()
  expect(request).not.toHaveBeenCalled()
})
