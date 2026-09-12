import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, test, vi, beforeEach } from 'vitest'
import PromptPreviewDialog from '../PromptPreviewDialog.vue'
import { requestReadableText } from '../../../../../shared/promptPreview'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/utils/vscode', () => ({ sendToExtension: rpc }))
vi.mock('@/utils/format', () => ({ copyToClipboard: vi.fn(async () => true) }))
const result = (text: string) => ({ protocol: 'openai', model: 'fixture', createdAt: 1234, estimatedTokens: 25, notices: [], body: {
  messages: [{ role: 'system', content: '系统要求\n角色描述' }, { role: 'user', content: text }], tools: [{ name: 'read_file' }],
} })
const mountDialog = (request = { message: '尚未发送的草稿' }) => mount(PromptPreviewDialog, { props: { modelValue: true, request },
  global: { stubs: { Modal: { template: '<div><slot /></div>' } } } })
beforeEach(() => { rpc.mockReset() })

describe('当前提示词预览', () => {
  test('阅读视图保留工具调用与回执关联，完整 JSON 的附件仍保持原值', () => {
    expect(requestReadableText({ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{}' } }] })).toContain('call-1')
    expect(requestReadableText({ type: 'tool_result', tool_use_id: 'call-1', content: '文件正文' })).toContain('tool_use_id')
  })
  test('按消息阅读保留换行，输入变化提示更新，查找和 JSON 都可用', async () => {
    rpc.mockImplementation(async (_type, data) => result(data.message))
    const wrapper = mountDialog(); await flushPromises()
    expect(wrapper.text()).toContain('尚未发送的草稿')
    expect(wrapper.find('.preview-group pre').text()).toBe('系统要求\n角色描述')
    await wrapper.setProps({ request: { message: '新的草稿' } })
    expect(wrapper.text()).toContain('输入或模型选择已变化')
    await wrapper.findAll('button').find(button => button.text() === '更新预览')!.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('新的草稿'); expect(wrapper.text()).not.toContain('尚未发送的草稿')
    await wrapper.get('input[type=search]').setValue('新的草稿'); expect(wrapper.findAll('.preview-group')).toHaveLength(1)
    await wrapper.findAll('button').find(button => button.text() === '完整 JSON')!.trigger('click')
    expect(JSON.parse(wrapper.get('.preview-json').text()).messages[1].content).toBe('新的草稿')
    expect(rpc.mock.calls.every(call => call[0] === 'prompt.preview')).toBe(true)
    wrapper.unmount()
  })

  test('关闭再打开后，较早的响应不能覆盖新的预览', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void
    rpc.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce(result('当前对话'))
    const wrapper = mountDialog(); await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true, request: { message: '当前对话' } }); await flushPromises()
    resolve(result('已经关闭的旧对话')); await flushPromises()
    expect(wrapper.text()).toContain('当前对话'); expect(wrapper.text()).not.toContain('已经关闭的旧对话')
    wrapper.unmount()
  })
})
