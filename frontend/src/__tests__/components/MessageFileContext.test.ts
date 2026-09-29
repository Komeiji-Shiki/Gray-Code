import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defineComponent, h, provide, ref, type Ref } from 'vue'
import MarkdownRenderer from '../../components/common/MarkdownRenderer.vue'
import { invalidateWorkspaceAssets } from '../../components/common/markdown/markdownItCore'
import { messageConversationKey } from '../../composables/messageConversationContext'
import { useOpenWorkspaceFile } from '../../composables/useOpenWorkspaceFile'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), showNotification: vi.fn() }))
const request = vi.mocked(sendToExtension)
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => { invalidateWorkspaceAssets(); request.mockReset(); vi.useFakeTimers() })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })

function markdown(conversation: Ref<string | undefined>, content: string) {
  const wrapper = mount(defineComponent({ setup() {
    provide(messageConversationKey, conversation)
    return () => h(MarkdownRenderer, { content })
  } }))
  wrappers.push(wrapper)
  return wrapper
}
async function settle() { await vi.advanceTimersByTimeAsync(0); await flushPromises() }

test('同时显示的对话和普通预览分别读取同名资源，缓存及点击保持所属对话', async () => {
  request.mockImplementation(async (method, data: any) => method === 'readWorkspaceImage'
    ? { success: true, data: data.conversationId === 'A' ? 'AAAA' : data.conversationId === 'B' ? 'BBBB' : 'CCCC' }
    : { results: { 'src/only.ts': data.conversationId === 'A' } })
  const content = '`src/only.ts`\n\n![图片](same.png)\n\n[文件](source.ts:7)'
  const a = markdown(ref('A'), content), b = markdown(ref('B'), content), plain = markdown(ref(undefined), content)
  await settle()
  expect(a.get('img').attributes('src')).toBe('data:image/png;base64,AAAA')
  expect(b.get('img').attributes('src')).toBe('data:image/png;base64,BBBB')
  expect(plain.get('img').attributes('src')).toBe('data:image/png;base64,CCCC')
  expect(a.find('a.workspace-file-link').exists()).toBe(true)
  expect(b.find('a.workspace-file-link').exists()).toBe(false)
  request.mockClear()
  await a.get('img').trigger('click')
  await b.findAll('a').find(link => link.text() === '文件')!.trigger('click')
  expect(request).toHaveBeenCalledWith('openWorkspaceFile', { path: 'same.png', conversationId: 'A' })
  expect(request).toHaveBeenCalledWith('openWorkspaceFileAt', expect.objectContaining({ path: 'source.ts', startLine: 7, conversationId: 'B' }))
  await plain.get('img').trigger('click')
  expect(request).toHaveBeenCalledWith('openWorkspaceFile', { path: 'same.png' })
})

test('对话切换后相同正文重新读取图片，旧请求返回后仍显示新对话的图片', async () => {
  let finish!: (value: unknown) => void
  request.mockImplementation(async (method, data: any) => method === 'readWorkspaceImage'
    ? data.conversationId === 'A' ? new Promise(resolve => { finish = resolve }) : { success: true, data: 'BBBB' }
    : { results: {} })
  const conversation = ref('A'), wrapper = markdown(conversation, '![图片](same.png)')
  await settle()
  conversation.value = 'B'; await settle()
  expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,BBBB')
  finish({ success: true, data: 'AAAA' }); await settle()
  expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,BBBB')
  request.mockClear(); invalidateWorkspaceAssets(['same.png']); await settle()
  expect(request).toHaveBeenCalledWith('readWorkspaceImage', { path: 'same.png', conversationId: 'B' })
})

test('工具文件入口传入消息对话，行号和范围仍准确', async () => {
  request.mockResolvedValue({})
  const conversation = ref('A')
  const Tool = defineComponent({ setup() { const { openFileAt } = useOpenWorkspaceFile(); return () => h('button', { onClick: () => openFileAt('source.ts', 17, 20) }, '打开') } })
  const wrapper = mount(defineComponent({ setup() { provide(messageConversationKey, conversation); return () => h(Tool) } }))
  wrappers.push(wrapper)
  await wrapper.get('button').trigger('click')
  expect(request).toHaveBeenCalledWith('openWorkspaceFileAt', { path: 'source.ts', startLine: 17, endLine: 20, conversationId: 'A' })
  conversation.value = 'B'; await wrapper.get('button').trigger('click')
  expect(request).toHaveBeenLastCalledWith('openWorkspaceFileAt', { path: 'source.ts', startLine: 17, endLine: 20, conversationId: 'B' })
})
