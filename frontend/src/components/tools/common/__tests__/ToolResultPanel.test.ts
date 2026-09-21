import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import { DefaultToolResult, getToolConfig, registerTool, toolRegistry } from '../../../../utils/toolRegistry'
import { toolImage, toolLink, toolRawData } from '../../../../utils/toolPresentation'
import ToolResultPanel from '../ToolResultPanel.vue'
import ToolResultValue from '../ToolResultValue.vue'
import McpToolPanel from '../../mcp/mcp_tool.vue'

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => { setLanguage('auto'); toolRegistry.unregister('custom_display_fixture') })

test('浏览器结果展示网址、页面内容与真实的零和布尔值，原始数据按需生成', async () => {
  const wrapper = mount(ToolResultPanel, { props: { args: { action: 'snapshot', tabId: 'fixture' }, status: 'success',
    result: { success: true, data: { title: 'Google Search', url: 'https://www.google.com/search?q=GrayCode', nodes: ['[a] heading "GrayCode"'], count: 0, truncated: false } } } })
  try {
    expect(wrapper.find('.result-link').attributes('href')).toBe('https://www.google.com/search?q=GrayCode')
    expect(wrapper.text()).toContain('[a] heading "GrayCode"')
    expect(wrapper.find('.result-number').text()).toBe('0')
    expect(wrapper.find('.result-boolean').text()).toBe('否')
    expect(wrapper.find('.result-raw .result-text').exists()).toBe(false)
    const raw = wrapper.find<HTMLDetailsElement>('.result-raw'); raw.element.open = true; await raw.trigger('toggle')
    expect(wrapper.find('.result-raw .result-text').text()).toContain('"tabId": "fixture"')
    setLanguage('en'); await wrapper.vm.$nextTick()
    expect(wrapper.find('.result-boolean').text()).toBe('No')
    expect(wrapper.find('.result-raw summary').text()).toBe('View raw data')
  } finally { wrapper.unmount() }
})

test('大型列表分页挂载，长文本逐段展开，嵌套集合未展开时不生成子内容', async () => {
  const list = mount(ToolResultValue, { props: { value: Array.from({ length: 100 }, (_, index) => `entry-${index}`) } })
  const text = mount(ToolResultValue, { props: { value: 'x'.repeat(10000) } })
  const nested = mount(ToolResultValue, { props: { value: { nested: { hidden: '等待展开' } } } })
  try {
    expect(list.findAll('.result-list > li')).toHaveLength(20)
    await list.find('.result-more').trigger('click')
    expect(list.findAll('.result-list > li')).toHaveLength(40)
    expect(text.find('pre').text()).toHaveLength(3000)
    await text.find('.result-more').trigger('click'); expect(text.find('pre').text()).toHaveLength(10000)
    expect(nested.text()).not.toContain('等待展开')
    const details = nested.find<HTMLDetailsElement>('details'); details.element.open = true; await details.trigger('toggle')
    expect(nested.text()).toContain('等待展开')
  } finally { list.unmount(); text.unmount(); nested.unmount() }
})

test('MCP 文本内容支持结构化结果和图片，错误不隐藏已有输出', () => {
  const image = { mimeType: 'image/png', data: 'aGVsbG8=', name: 'fixture.png' }
  const wrapper = mount(McpToolPanel, { props: { args: {}, result: { success: false, error: '部分请求失败',
    data: { content: [{ type: 'text', text: '{"message":"已读取的内容","count":2}' }] }, multimodal: [image] } } })
  try {
    expect(wrapper.find('[role="alert"]').text()).toContain('部分请求失败')
    expect(wrapper.text()).toContain('已读取的内容')
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(wrapper.text()).not.toContain('aGVsbG8=')
    expect(toolRawData(image)).not.toContain('aGVsbG8=')
  } finally { wrapper.unmount() }
})

test('未知工具与平台新工具均有结构化展示，已有专用组件保持优先', () => {
  for (const name of ['browser_tabs', 'browser_read', 'computer_observe', 'team_tasks', 'context_notes', 'memory_search', 'pet_control', 'future_tool']) {
    expect(getToolConfig(name)?.contentComponent).toBe(DefaultToolResult)
    expect(getToolConfig(name)?.descriptionFormatter({ query: '测试查询' })).toBe('测试查询')
  }
  const component = { template: '<div>专用结果</div>' }
  registerTool('custom_display_fixture', { name: 'custom_display_fixture', descriptionFormatter: () => '专用', contentComponent: component })
  expect(getToolConfig('custom_display_fixture')?.contentComponent).toBe(component)
})

test('任务条目保留名称和状态，避免标题重复占用窄屏空间', () => {
  const wrapper = mount(ToolResultValue, { props: { value: [{ title: '验证浏览器', id: 'task-1', status: 'completed' }] } })
  try {
    expect(wrapper.text().match(/验证浏览器/g)).toHaveLength(1)
    expect(wrapper.find('.result-status').text()).toBe('已完成')
    expect(wrapper.find('.result-status').attributes('title')).toBe('completed')
    expect(wrapper.text()).toContain('task-1')
  } finally { wrapper.unmount() }
})

test('网页内容作为文本呈现，不执行脚本，也不自动请求远程图片', () => {
  expect(toolLink('javascript:alert(1)')).toBeUndefined()
  expect(toolLink('https://user:password@example.com')).toBeUndefined()
  expect(toolImage({ mimeType: 'image/svg+xml', data: 'aGVsbG8=' })).toBeUndefined()
  expect(toolImage('https://example.com/tracker.png')).toBeUndefined()
  const wrapper = mount(ToolResultValue, { props: { value: '<img src=x onerror=alert(1)>' } })
  try { expect(wrapper.find('img').exists()).toBe(false); expect(wrapper.text()).toContain('<img') } finally { wrapper.unmount() }
})

test('等待状态保留参数，空的成功结果和直接返回的标量都有明确显示', () => {
  const waiting = mount(ToolResultPanel, { props: { args: { action: 'list' }, status: 'executing' } })
  const completed = mount(ToolResultPanel, { props: { args: {}, result: { success: true } } })
  const scalar = mount(ToolResultPanel, { props: { args: {}, result: false } })
  try {
    expect(waiting.find('[role="status"]').exists()).toBe(true)
    expect(waiting.find('details.result-parameters').attributes()).toHaveProperty('open')
    expect(completed.text()).toContain('操作已完成，没有额外输出')
    expect(scalar.find('.result-boolean').text()).toBe('否')
  } finally { waiting.unmount(); completed.unmount(); scalar.unmount() }
})
