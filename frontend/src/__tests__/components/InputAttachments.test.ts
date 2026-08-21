/**
 * InputAttachments 组件测试。
 *
 * 背景（GIF 直发问题 + 输入框被附件挤占问题修复轮）：
 * 旧实现是纵向列表——每个附件占一整行（图标/缩略图 + 名称 + 大小 + 关闭），
 * 图片一多就把输入框顶出可视区。新实现改为：媒体附件 64px 缩略图块、
 * 非媒体附件紧凑 chip、横向 flex-wrap 排列，整体限高滚动。
 *
 * 本测试覆盖：媒体/非媒体渲染分支、preview 与 remove 事件、多附件渲染。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import InputAttachments from '../../components/input/InputAttachments.vue'
import type { Attachment } from '../../types'

vi.mock('../../i18n', async (importOriginal) => {
  // 保留真实模块的其余导出（t 被 utils/file 等模块顶层使用），仅替换 useI18n 为测试桩
  const actual = await importOriginal<typeof import('../../i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    name: 'a.png',
    type: 'image',
    size: 1024,
    mimeType: 'image/png',
    data: 'base64data',
    ...overrides
  }
}

function mountAttachments(attachments: Attachment[]): VueWrapper {
  return mount(InputAttachments, {
    props: { attachments }
  })
}

describe('InputAttachments', () => {
  it('renders an image attachment as a thumbnail tile', () => {
    const wrapper = mountAttachments([makeAttachment({ thumbnail: 'data:image/png;base64,x' })])
    const img = wrapper.get('.attachment-tile.is-media img')
    expect(img.attributes('src')).toBe('data:image/png;base64,x')
    expect(img.attributes('alt')).toBe('a.png')
  })

  it('renders a media tile with icon placeholder when no thumbnail', () => {
    const wrapper = mountAttachments([makeAttachment({ type: 'audio', mimeType: 'audio/mp3' })])
    expect(wrapper.find('.attachment-tile.is-media .media-placeholder').exists()).toBe(true)
    expect(wrapper.find('.media-placeholder .codicon-unmute').exists()).toBe(true)
  })

  it('renders a document attachment as a compact chip', () => {
    const wrapper = mountAttachments([makeAttachment({
      id: 'doc-1',
      name: 'report.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      size: 2048
    })])
    const chip = wrapper.get('.attachment-tile:not(.is-media)')
    expect(chip.text()).toContain('report.pdf')
    expect(chip.text()).toContain('2 KB')
    expect(chip.find('.codicon-file').exists()).toBe(true)
  })

  it('emits preview when clicking the media tile', async () => {
    const attachment = makeAttachment({ thumbnail: 'data:image/png;base64,x' })
    const wrapper = mountAttachments([attachment])
    await wrapper.get('.attachment-tile.is-media .tile-media').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.emitted('preview')![0][0]).toEqual(attachment)
  })

  it('emits remove with the attachment id', async () => {
    const wrapper = mountAttachments([
      makeAttachment({ id: 'img-1', thumbnail: 'data:image/png;base64,x' }),
      makeAttachment({ id: 'doc-1', name: 'x.pdf', type: 'document', mimeType: 'application/pdf' })
    ])
    await wrapper.get('.attachment-tile.is-media .tile-remove').trigger('click')
    await wrapper.get('.attachment-tile:not(.is-media) .chip-remove').trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(2)
    expect(wrapper.emitted('remove')![0][0]).toBe('img-1')
    expect(wrapper.emitted('remove')![1][0]).toBe('doc-1')
  })

  it('renders multiple attachments without stacking rows', () => {
    const attachments = Array.from({ length: 12 }, (_, i) => makeAttachment({
      id: `img-${i}`,
      name: `img-${i}.png`,
      thumbnail: `data:image/png;base64,${i}`
    }))
    const wrapper = mountAttachments(attachments)
    expect(wrapper.findAll('.attachment-tile')).toHaveLength(12)
    // 列表容器为横向 wrap 布局
    const list = wrapper.get('.attachments-list')
    expect(list.classes().length).toBeGreaterThan(0)
    expect(getComputedStyle(list.element).flexDirection).not.toBe('column')
  })

  it('disables remove buttons while uploading', () => {
    const wrapper = mount(InputAttachments, {
      props: {
        attachments: [makeAttachment({ thumbnail: 'data:image/png;base64,x' })],
        uploading: true
      }
    })
    expect(wrapper.get('.tile-remove').attributes('disabled')).toBeDefined()
  })
})
