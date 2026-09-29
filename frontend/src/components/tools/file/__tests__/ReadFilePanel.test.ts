import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import ReadFilePanel from '../read_file.vue'
import { setLanguage } from '../../../../i18n'
import { sendToExtension } from '../../../../utils/vscode'
import { copyToClipboard } from '../../../../utils/format'

vi.mock('../../../../utils/vscode', () => ({ sendToExtension: vi.fn().mockResolvedValue({ success: true }), showNotification: vi.fn() }))
vi.mock('../../../../utils/format', async importOriginal => ({ ...await importOriginal<typeof import('../../../../utils/format')>(), copyToClipboard: vi.fn().mockResolvedValue(true) }))

beforeEach(() => { setLanguage('zh-CN'); vi.clearAllMocks() })
afterEach(() => setLanguage('auto'))

const render = (props: Record<string, unknown>) => mount(ReadFilePanel, {
  props: { args: {}, ...props }, global: { stubs: { CustomScrollbar: { template: '<div><slot /></div>' } } }
})

test('读取回执到达前显示等待，成功计数和空文件由真实回执决定', async () => {
  const wrapper = render({ args: { path: 'empty.txt' }, status: 'executing' })
  try {
    expect(wrapper.find('.stat.success').exists()).toBe(false)
    expect(wrapper.find('.file-empty').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    await wrapper.setProps({ result: { success: true, data: { results: [{ path: 'empty.txt', success: true, type: 'text', content: '', lineCount: 0 }], successCount: 1, failCount: 0 } } })
    expect(wrapper.find('.stat.success').text()).toBe('1')
    expect(wrapper.find('.file-empty').exists()).toBe(true)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('同一文件的多个读取范围分别展开、复制和定位', async () => {
  const results = [1, 101].map(startLine => ({ path: 'source.ts', success: true, startLine, endLine: startLine + 29, totalLines: 200,
    content: Array.from({ length: 30 }, (_, index) => `${startLine + index} | value-${startLine + index}`).join('\n') }))
  const wrapper = render({ args: { files: results.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })) }, result: { success: true, data: { results } } })
  try {
    const panels = wrapper.findAll('.file-panel')
    await panels[0].get('.expand-btn').trigger('click')
    expect(panels[0].get('pre').text().split('\n')).toHaveLength(30)
    expect(panels[1].get('pre').text().split('\n')).toHaveLength(15)
    await panels[0].get('.action-btn').trigger('click'); await flushPromises()
    expect(copyToClipboard).toHaveBeenCalledWith(results[0].content.replace(/^\d+ \| /gm, ''))
    expect(panels[0].get('.action-btn').classes()).toContain('copied')
    expect(panels[1].get('.action-btn').classes()).not.toContain('copied')
    await panels[1].get('.file-name').trigger('click')
    expect(sendToExtension).toHaveBeenCalledWith('openWorkspaceFileAt', { path: 'source.ts', startLine: 101, endLine: 130 })
  } finally { wrapper.unmount() }
})

test('全局读取失败保留错误，不伪造逐文件空内容', () => {
  const wrapper = render({ args: { path: 'source.ts' }, status: 'error', error: '请求已取消' })
  try {
    expect(wrapper.get('.panel-error').text()).toContain('请求已取消')
    expect(wrapper.find('.file-empty').exists()).toBe(false)
    expect(wrapper.find('.stat.success').exists()).toBe(false)
  } finally { wrapper.unmount() }
})
