import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import MediaToolPanel from '../../components/tools/media/MediaToolPanel.vue'
import { messageConversationKey } from '../../composables/messageConversationContext'
import { sendToExtension } from '../../utils/vscode'
import { setLanguage } from '../../i18n'
import { isPartialToolData } from '@shared/toolResultStatus'

const { cancelStream } = vi.hoisted(() => ({ cancelStream: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({ useChatStore: () => ({ currentConversationId: 'another-chat', cancelStream }) }))
vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), showNotification: vi.fn() }))
const request = vi.mocked(sendToExtension), wrappers: VueWrapper[] = []
beforeEach(() => { setLanguage('zh-CN'); request.mockReset(); cancelStream.mockReset() })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })
function render(extra: Record<string, unknown> = {}) {
  const conversation = ref('message-chat')
  const wrapper = mount(MediaToolPanel, { props: {
    status: 'executing', toolId: 'image-call', tasks: [], isBatch: false, ns: 'components.tools.media.cropImagePanel', icon: 'codicon-selection',
    batchTitleKey: 'batchCrop', singleTitleKey: 'cropTask', cancelTitleKey: 'cancelCrop', runningTextKey: 'croppingImages', taskTitle: () => '', ...extra
  }, global: { provide: { [messageConversationKey as symbol]: conversation } } })
  wrappers.push(wrapper); return { wrapper, conversation }
}

test.each(['response', 'transport'])('单个图片任务的 %s 取消失败显示原因，并保留其他对话运行', async kind => {
  if (kind === 'response') request.mockResolvedValue({ success: false, error: '图片任务已经结束' })
  else request.mockRejectedValue(new Error('连接已中断'))
  const { wrapper } = render()
  await wrapper.get('.cancel-btn').trigger('click'); await flushPromises()
  expect(request).toHaveBeenCalledWith('task.cancel', { taskId: 'image-call', conversationId: 'message-chat' })
  expect(cancelStream).not.toHaveBeenCalled()
  expect(wrapper.get('.cancel-error').text()).toContain(kind === 'response' ? '图片任务已经结束' : '连接已中断')
})

test('切换对话后迟到的取消失败不覆盖新卡片，生成工具保留专用取消通道', async () => {
  let finish!: (value: unknown) => void; request.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const { wrapper, conversation } = render({ cancelChannel: 'imageGeneration.cancel', cancelIdField: 'toolId' })
  await wrapper.get('.cancel-btn').trigger('click')
  conversation.value = 'next-chat'; await flushPromises()
  finish({ success: false, error: '旧任务错误' }); await flushPromises()
  expect(request).toHaveBeenCalledWith('imageGeneration.cancel', { toolId: 'image-call', conversationId: 'message-chat' })
  expect(wrapper.find('.cancel-error').exists()).toBe(false)
  expect(cancelStream).not.toHaveBeenCalled()
})

test.each(['streaming', 'queued', 'awaiting_approval'])('%s 状态的图片任务等待执行，不展示任务取消入口', status => {
  const { wrapper } = render({ status })
  expect(wrapper.find('.cancel-btn').exists()).toBe(false)
  expect(wrapper.get('.status-badge').classes()).toContain('pending')
})

test('最终图片回执优先于尚未更新的执行状态，混合结果保留部分成功', async () => {
  const { wrapper } = render({ result: { success: true, data: { successCount: 1, failedCount: 0 } } })
  expect(wrapper.find('.cancel-btn').exists()).toBe(false)
  expect(wrapper.get('.status-badge').classes()).toContain('success')
  await wrapper.setProps({ result: { success: false, data: { successCount: 1, failedCount: 1 } } })
  expect(wrapper.get('.status-badge').text()).toBe('部分成功')
  expect(wrapper.get('.status-badge').classes()).toContain('warning')
})

test.each(['failCount', 'failedCount', 'cancelledCount'])('混合结果识别 %s，全部失败仍保留失败语义', field => {
  expect(isPartialToolData({ successCount: 1, [field]: 1 })).toBe(true)
  expect(isPartialToolData({ successCount: 0, [field]: 1 })).toBe(false)
  expect(isPartialToolData({ successCount: 1, [field]: 0 })).toBe(false)
})
