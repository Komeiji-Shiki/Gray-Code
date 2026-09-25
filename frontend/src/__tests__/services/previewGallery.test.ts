import { afterEach, describe, expect, it } from 'vitest'
import { buildPreviewAttachmentPayload, trimPreviewGallery } from '../../services/context'
import type { Attachment } from '../../types'

function image(id: string, data: string): Attachment {
  return { id, name: `${id}.png`, type: 'image', size: data.length, mimeType: 'image/png', data }
}

afterEach(() => { delete window.__GRAYCODE_HOST })

describe('trimPreviewGallery', () => {
  it('预算内保持原样', () => {
    const items = [image('a', 'AAAA'), image('b', 'BBBB'), image('c', 'CCCC')]
    const trimmed = trimPreviewGallery(items, 1, 1024)
    expect(trimmed.items.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(trimmed.index).toBe(1)
  })

  it('超预算时优先丢弃离当前图片最远的图片，并跟随索引变化', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map(id => image(id, id.toUpperCase().repeat(10)))
    const trimmed = trimPreviewGallery(items, 2, 22)
    expect(trimmed.items.map(item => item.id)).toEqual(['b', 'c'])
    expect(trimmed.index).toBe(1)
  })

  it('只剩当前图片时停止裁剪', () => {
    const items = [image('a', 'A'.repeat(10)), image('b', 'B'.repeat(10)), image('c', 'C'.repeat(10))]
    const trimmed = trimPreviewGallery(items, 1, 0)
    expect(trimmed.items.map(item => item.id)).toEqual(['b'])
    expect(trimmed.index).toBe(0)
  })
})

describe('buildPreviewAttachmentPayload', () => {
  it('没有独立宿主时保持单图消息（VS Code 扩展路径）', () => {
    const images = [image('a', 'AAAA'), image('b', 'BBBB')]
    expect(buildPreviewAttachmentPayload(images[0], images)).toEqual({ name: 'a.png', mimeType: 'image/png', data: 'AAAA' })
  })

  it('独立宿主携带整组图片与当前下标', () => {
    window.__GRAYCODE_HOST = { postMessage() {}, getState: () => undefined, setState() {} }
    const images = [image('a', 'AAAA'), image('b', 'BBBB'), image('c', 'CCCC')]
    expect(buildPreviewAttachmentPayload(images[1], images)).toEqual({
      gallery: [
        { name: 'a.png', mimeType: 'image/png', data: 'AAAA' },
        { name: 'b.png', mimeType: 'image/png', data: 'BBBB' },
        { name: 'c.png', mimeType: 'image/png', data: 'CCCC' }
      ],
      index: 1
    })
  })

  it('非图片附件与落单图片不携带图片组', () => {
    window.__GRAYCODE_HOST = { postMessage() {}, getState: () => undefined, setState() {} }
    const video: Attachment = { id: 'v', name: 'v.mp4', type: 'video', size: 4, mimeType: 'video/mp4', data: 'VVVV' }
    const images = [image('a', 'AAAA'), image('b', 'BBBB')]
    expect(buildPreviewAttachmentPayload(video, [video, ...images])).toEqual({ name: 'v.mp4', mimeType: 'video/mp4', data: 'VVVV' })
    expect(buildPreviewAttachmentPayload(images[0], [images[0]])).toEqual({ name: 'a.png', mimeType: 'image/png', data: 'AAAA' })
  })
})
