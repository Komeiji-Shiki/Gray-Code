import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import SearchInFilesPanel from '../search_in_files.vue'
import { setLanguage } from '../../../../i18n'

const { load, send } = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn() }))
vi.mock('../../../../utils/vscode', () => ({ loadDiffContent: load, sendToExtension: send, showNotification: vi.fn() }))
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => { setLanguage('zh-CN'); load.mockReset(); send.mockReset().mockResolvedValue({ success: true }) })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })
const render = (args: Record<string, unknown>, result?: Record<string, unknown>) => {
  const wrapper = mount(SearchInFilesPanel, { props: { args, result }, global: { stubs: {
    CustomScrollbar: { template: '<div><slot /></div>' },
    VirtualDiffLines: defineComponent({ props: ['lines'], setup: props => () => h('pre', { class: 'diff-lines' }, JSON.stringify(props.lines)) })
  } } })
  wrappers.push(wrapper); return wrapper
}
const replacement = (diffContentId?: string) => ({ success: true, data: { results: [{ file: 'source.txt', replacements: 1, diffContentId }],
  matches: [{ file: 'source.txt', line: 1, column: 1, match: 'old', context: 'old' }], filesModified: 1, totalReplacements: 1 } })

test('原型同名的合法文件也能显示结果与文件数量', () => {
  const results = ['constructor', '__proto__'].map(file => ({ file, line: 1, column: 1, match: 'text', context: 'text' }))
  const wrapper = render({ query: 'text' }, { success: true, data: { results, count: 2 } })
  expect(wrapper.findAll('.match-item')).toHaveLength(2)
  expect(wrapper.text()).toContain('constructor')
  expect(wrapper.text()).toContain('__proto__')
})

test('搜索高亮保留原文大小写和 HTML 符号', () => {
  const context = 'AMP & amp <widget> $&'
  const wrapper = render({ query: 'amp' }, { success: true, data: { results: [{ file: 'text.txt', line: 1, column: 1, match: 'amp', context }], count: 1 } })
  expect(wrapper.get('.match-context code').text()).toBe(context)
  expect(wrapper.findAll('mark').map(mark => mark.text())).toEqual(['AMP', 'amp'])
  expect(wrapper.find('widget').exists()).toBe(false)
})

test('搜索回执到达前显示等待，文件入口跳转到命中行', async () => {
  const wrapper = render({ query: 'text' })
  expect(wrapper.find('.no-results').exists()).toBe(false)
  expect(wrapper.find('[role="status"]').exists()).toBe(true)
  await wrapper.setProps({ result: { success: true, data: { results: [{ file: 'source.ts', line: 17, column: 4, match: 'text', context: 'text' }] } } })
  await wrapper.get('.match-header .file-path').trigger('click')
  expect(send).toHaveBeenCalledWith('openWorkspaceFileAt', { path: 'source.ts', startLine: 17 })
})

test('旧回执中拒绝的候选不算已替换，中止信息保留已处理文件', async () => {
  const wrapper = render({ mode: 'replace', query: 'old', replace: 'new' }, { success: true, data: {
    filesModified: 2, totalReplacements: 4, results: [
      { file: 'first.txt', replacements: 2, status: 'accepted' },
      { file: 'second.txt', replacements: 2, status: 'rejected' }
    ]
  } })
  expect(wrapper.get('.header-stats').text().replace(/\s/g, '')).toContain('已替换2处')
  expect(wrapper.findAll('.replace-status').map(item => item.text())).toEqual(['已应用', '已拒绝'])
  await wrapper.setProps({ error: '搜索已取消' })
  expect(wrapper.findAll('.replace-file-panel')).toHaveLength(2)
  expect(wrapper.get('.panel-error').text()).toContain('搜索已取消')
})

test('跳过文件的原因可以查看，后台返回后才显示零命中', async () => {
  const wrapper = render({ query: 'text' }, { success: true, data: { results: [], skippedFiles: [{ file: 'locked.txt', reason: '文件读取失败' }] } })
  expect(wrapper.find('.no-results').exists()).toBe(true)
  const details = wrapper.get<HTMLDetailsElement>('.skipped-files')
  expect(details.get('summary').text()).toBe('跳过 1 个文件')
  details.element.open = true; await details.trigger('toggle')
  expect(details.text()).toContain('文件读取失败')
})

test('载入的差异真实出现在结果中，同一路径的新差异替换旧请求', async () => {
  let resolveOld!: (value: unknown) => void
  load.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce({ originalContent: 'base', newContent: 'latest', filePath: 'source.txt' })
  const wrapper = render({ mode: 'replace', query: 'old', replace: 'new' }, replacement('old-id'))
  await wrapper.setProps({ result: replacement('new-id') }); await flushPromises()
  expect(load.mock.calls.map(([id]) => id)).toEqual(['old-id', 'new-id'])
  expect(wrapper.get('.diff-lines').text()).toContain('latest')
  resolveOld({ originalContent: 'base', newContent: 'obsolete', filePath: 'source.txt' }); await flushPromises()
  expect(wrapper.get('.diff-lines').text()).toContain('latest')
  expect(wrapper.get('.diff-lines').text()).not.toContain('obsolete')
  await wrapper.setProps({ result: replacement() }); await flushPromises()
  expect(wrapper.find('.diff-view').exists()).toBe(false)
})

test('差异加载失败可重试，成功后显示差异正文', async () => {
  load.mockRejectedValueOnce(new Error('预览读取失败')).mockResolvedValueOnce({ originalContent: 'base', newContent: 'retried', filePath: 'source.txt' })
  const wrapper = render({ mode: 'replace', query: 'old', replace: 'new' }, replacement('retry-id'))
  await flushPromises()
  expect(wrapper.get('.diff-load-error').text()).toContain('预览读取失败')
  await wrapper.get('.diff-load-error button').trigger('click'); await flushPromises()
  expect(load).toHaveBeenCalledTimes(2)
  expect(wrapper.get('.diff-lines').text()).toContain('retried')
})
