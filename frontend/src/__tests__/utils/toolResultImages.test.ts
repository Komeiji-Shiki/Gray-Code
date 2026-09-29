import { expect, test, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { projectToolResultImages } from '../../utils/toolResultImages'
import MediaToolPanel from '../../components/tools/media/MediaToolPanel.vue'
import { sendToExtension } from '../../utils/vscode'
import type { ContentPart } from '../../types'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), showNotification: vi.fn() }))

test('相邻图片按工具调用关联，原始响应、消息顺序和图片内容保持不变', () => {
  const response = { success: true, data: { value: 'original' } }
  const parts: Array<ContentPart & { displayName?: string }> = [
    { functionResponse: { id: 'A', name: 'tool', response } },
    { inlineData: { mimeType: 'image/png', data: 'AAAA' }, displayName: 'first.png' },
    { functionResponse: { id: 'B', name: 'tool', response } },
    { inlineData: { mimeType: 'image/png', data: 'BBBB', name: 'second.png' } }
  ]
  const original = structuredClone(parts)
  const first = projectToolResultImages(response, parts, 'A')!
  expect(first.multimodal).toEqual([{ mimeType: 'image/png', data: 'AAAA', name: 'first.png' }])
  expect(projectToolResultImages(response, parts, 'A')).toBe(first)
  expect(projectToolResultImages(response, parts, 'B')!.multimodal).toEqual([{ mimeType: 'image/png', data: 'BBBB', name: 'second.png' }])
  expect(response).not.toHaveProperty('multimodal')
  expect(parts).toEqual(original)
})

test('旧的嵌入图片保持原样，未匹配回执和无图片结果复用原对象', () => {
  const legacy = { success: true, multimodal: [{ mimeType: 'image/png', data: 'AAAA' }] }
  const parts: ContentPart[] = [{ functionResponse: { id: 'A', name: 'tool', response: legacy } }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }]
  expect(projectToolResultImages(legacy, parts, 'A')).toBe(legacy)
  const plain = { success: true }
  expect(projectToolResultImages(plain, parts, 'missing')).toBe(plain)
  expect(projectToolResultImages(plain, [], 'A')).toBe(plain)
})

test('媒体卡片识别附件回执并打开预览，顶层取消标志保持取消语义', async () => {
  vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  const image = { mimeType: 'image/png', data: 'AAAA', name: 'output.png' }
  const wrapper = mount(MediaToolPanel, { props: {
    status: 'success', tasks: [], isBatch: false, ns: 'components.tools.media.cropImagePanel', icon: 'codicon-selection',
    batchTitleKey: 'batchCrop', singleTitleKey: 'cropTask', cancelTitleKey: 'cancelCrop', runningTextKey: 'croppingImages', taskTitle: () => '',
    result: { success: true, attachments: [image] }
  } })
  try {
    await wrapper.get('button.image-wrapper').trigger('click'); await flushPromises()
    expect(sendToExtension).toHaveBeenCalledWith('previewAttachment', image)
    await wrapper.setProps({ result: { success: false, cancelled: true, data: { cancelledCount: 1 } } })
    expect(wrapper.get('.status-badge').classes()).toContain('cancelled')
  } finally { wrapper.unmount(); vi.clearAllMocks() }
})
