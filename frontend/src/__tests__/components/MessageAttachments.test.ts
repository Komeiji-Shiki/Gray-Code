import { mount } from '@vue/test-utils'
import { MESSAGE_NAMES } from '@shared/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MessageAttachments from '../../components/message/MessageAttachments.vue'
import { contentToMessageEnhanced } from '../../stores/chat/parsers'
import type { Attachment, Content } from '../../types'

const sendToExtensionMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../../utils/vscode', () => ({
  sendToExtension: (...args: unknown[]) => sendToExtensionMock(...args),
  showNotification: vi.fn()
}))

function largePngData(): string {
  // 只需 PNG 头部即可模拟历史解析器识别到超过 512px 的图片。
  const header = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 4, 0, 0, 0, 3, 0
  ])
  return btoa(String.fromCharCode(...header))
}

describe('MessageAttachments', () => {
  afterEach(() => { delete window.__GRAYCODE_HOST })

  it('模型回复替换用户消息后，仍显示大图并能打开原图', async () => {
    sendToExtensionMock.mockClear()
    const data = largePngData()
    const initial: Attachment = {
      id: 'image-1', name: 'image.png', type: 'image', size: 24,
      mimeType: 'image/png', data, thumbnail: 'data:image/png;base64,small-preview'
    }
    const wrapper = mount(MessageAttachments, { props: { attachments: [initial] } })
    expect(wrapper.get('img.attachment-preview').attributes('src')).toBe(initial.thumbnail)

    const persisted: Content = {
      role: 'user',
      parts: [{ inlineData: { id: 'image-1', name: 'image.png', mimeType: 'image/png', data } }]
    }
    const restored = contentToMessageEnhanced(persisted).attachments
    expect(restored).toHaveLength(1)
    expect(restored?.[0].thumbnail).toBeUndefined()

    await wrapper.setProps({ attachments: restored! })
    expect(wrapper.get('img.attachment-preview').attributes('src')).toBe(`data:image/png;base64,${data}`)
    await wrapper.get('button.media-preview-wrapper').trigger('click')
    expect(sendToExtensionMock).toHaveBeenCalledWith(MESSAGE_NAMES.previewAttachment, {
      name: 'image.png', mimeType: 'image/png', data
    })
    wrapper.unmount()
  })

  it('独立宿主点击图片时携带同一条消息的图片组，供查看器左右切换', async () => {
    sendToExtensionMock.mockClear()
    window.__GRAYCODE_HOST = { postMessage() {}, getState: () => undefined, setState() {} }
    const first: Attachment = { id: 'img-a', name: 'a.png', type: 'image', size: 4, mimeType: 'image/png', data: 'AAAA' }
    const second: Attachment = { id: 'img-b', name: 'b.png', type: 'image', size: 4, mimeType: 'image/png', data: 'BBBB' }
    const wrapper = mount(MessageAttachments, { props: { attachments: [first, second] } })
    await wrapper.findAll('button.media-preview-wrapper')[1].trigger('click')
    expect(sendToExtensionMock).toHaveBeenCalledWith(MESSAGE_NAMES.previewAttachment, {
      gallery: [
        { name: 'a.png', mimeType: 'image/png', data: 'AAAA' },
        { name: 'b.png', mimeType: 'image/png', data: 'BBBB' }
      ],
      index: 1
    })
    wrapper.unmount()
  })
})
