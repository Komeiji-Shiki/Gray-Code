import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import SearchInFilesPanel from '../search_in_files.vue'
import { setLanguage } from '../../../../i18n'

const { load, send } = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn() }))
vi.mock('../../../../utils/vscode', () => ({ loadDiffContent: load, sendToExtension: send, showNotification: vi.fn() }))
const wrappers: ReturnType<typeof mount>[] = []
const resizeCallbacks: ResizeObserverCallback[] = []
beforeEach(() => {
  setLanguage('zh-CN'); load.mockReset(); send.mockReset().mockResolvedValue({ success: true })
  resizeCallbacks.length = 0
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
    observe() {} unobserve() {} disconnect() {}
  })
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto'); vi.unstubAllGlobals() })
const render = (args: Record<string, unknown>, result?: Record<string, unknown>) => {
  const wrapper = mount(SearchInFilesPanel, { props: { args, result }, global: { stubs: {
    CustomScrollbar: defineComponent({ setup(_, { slots, expose }) {
      const element = ref<HTMLElement>()
      expose({ getContainer: () => element.value })
      return () => h('div', { ref: element, class: 'test-scroll-container' }, slots.default?.())
    } }),
    VirtualDiffLines: defineComponent({ props: ['lines'], setup: props => () => h('pre', { class: 'diff-lines' }, JSON.stringify(props.lines)) })
  } } })
  wrappers.push(wrapper); return wrapper
}
const replacement = (diffContentId?: string) => ({ success: true, data: { results: [{ file: 'source.txt', replacements: 1, diffContentId }],
  matches: [{ file: 'source.txt', line: 1, column: 1, match: 'old', context: 'old' }], filesModified: 1, totalReplacements: 1 } })

test('展开大量匹配只挂载附近行，滚动后保留原文件和行号跳转', async () => {
  const results = Array.from({ length: 120 }, (_, index) => ({ file: `file-${index}.ts`, line: index + 1, column: 1, match: 'text', context: 'text' }))
  const wrapper = render({ query: 'text' }, { success: true, data: { results, count: results.length } })
  await wrapper.get('.expand-btn').trigger('click')
  expect(wrapper.findAll('.match-item').length).toBeLessThan(20)
  const viewport = wrapper.get<HTMLElement>('.test-scroll-container')
  viewport.element.scrollTop = 8000
  await viewport.trigger('scroll')
  const target = wrapper.get('[data-match-index="100"] .file-path')
  await target.trigger('click')
  expect(send).toHaveBeenLastCalledWith('openWorkspaceFileAt', { path: 'file-100.ts', startLine: 101 })
  viewport.element.scrollTop = 240
  await viewport.trigger('scroll')
  const next = wrapper.get<HTMLElement>('[data-match-index="4"] .file-path')
  const focus = vi.spyOn(next.element, 'focus')
  await wrapper.get('[data-match-index="3"] .file-path').trigger('keydown', { key: 'ArrowDown' })
  expect(focus).toHaveBeenCalled()
})

test('变高匹配缩短后保留当前条目，旧行内偏移不会跳到后续结果', async () => {
  const results = Array.from({ length: 80 }, (_, index) => ({ file: `file-${index}`, line: 1, column: 1, match: 'text', context: 'text' }))
  const wrapper = render({ query: 'text' }, { success: true, data: { results } })
  await wrapper.get('.expand-btn').trigger('click')
  const viewport = wrapper.get<HTMLElement>('.test-scroll-container')
  const resize = async (height: number) => {
    resizeCallbacks.at(-1)!([{ target: wrapper.get('[data-match-index="0"]').element,
      borderBoxSize: [{ blockSize: height, inlineSize: 300 }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
    await flushPromises()
  }
  await resize(600)
  viewport.element.scrollTop = 500
  await viewport.trigger('scroll')
  await resize(80)
  expect(viewport.element.scrollTop).toBeLessThan(80)
  expect(wrapper.find('[data-match-index="0"]').exists()).toBe(true)
})

test('相同回执重建对象后保留高度和阅读锚点，全新结果回到顶部', async () => {
  const results = Array.from({ length: 80 }, (_, index) => ({ file: `file-${index}`, line: 1, column: 1, match: 'text', context: 'text' }))
  const wrapper = render({ query: 'text' }, { success: true, data: { results } })
  await wrapper.get('.expand-btn').trigger('click')
  resizeCallbacks.at(-1)!([{ target: wrapper.get('[data-match-index="0"]').element,
    borderBoxSize: [{ blockSize: 600, inlineSize: 300 }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
  await flushPromises()
  const viewport = wrapper.get<HTMLElement>('.test-scroll-container')
  viewport.element.scrollTop = 1000
  await viewport.trigger('scroll')
  await wrapper.setProps({ result: { success: true, data: { results: results.map(item => ({ ...item })) } } })
  await flushPromises()
  expect(viewport.element.scrollTop).toBe(1000)
  expect(wrapper.find('[data-match-index="6"]').exists()).toBe(true)
  await wrapper.setProps({ result: { success: true, data: { results: results.map(item => ({ ...item, file: `new-${item.file}` })) } } })
  await flushPromises()
  expect(viewport.element.scrollTop).toBe(0)
})

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
