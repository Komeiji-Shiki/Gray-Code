import { MESSAGE_NAMES } from '@shared/protocol'
import type { Attachment } from '../types'
import { sendToExtension } from '../utils/vscode'

/**
 * 独立宿主（桌面 / Web）图片组预览的预算：多图 base64 总字符上限。
 * 媒体通道对请求体有上限，超预算时按"离当前图片最远优先"裁剪组。
 */
export const PREVIEW_GALLERY_BUDGET_CHARS = 40 * 1024 * 1024

export interface PreviewGalleryItem {
  name: string
  mimeType: string
  data: string
}

export interface PreviewAttachmentPayload {
  name?: string
  mimeType?: string
  data?: string
  /** 独立宿主的图片组（含当前图片）；VS Code 扩展沿用单图消息时缺省。 */
  gallery?: PreviewGalleryItem[]
  /** 当前图片在 gallery 中的下标。 */
  index?: number
}

/** 按预算裁剪图片组：保留当前图片，优先丢弃离它最远的图片。原数组会被就地修改。 */
export function trimPreviewGallery<T extends { data?: string }>(items: T[], index: number, budget = PREVIEW_GALLERY_BUDGET_CHARS): { items: T[]; index: number } {
  let total = 0
  for (const item of items) total += item.data?.length ?? 0
  while (total > budget && items.length > 1) {
    const last = items.length - 1
    const dropAt = index <= last - index ? last : 0
    total -= items[dropAt].data?.length ?? 0
    items.splice(dropAt, 1)
    if (dropAt < index) index -= 1
  }
  return { items, index }
}

/**
 * 组装附件预览消息。桌面 / Web 宿主支持多图切换：同一条消息的图片打包成
 * gallery 一次注册，查看器可左右切换；VS Code 扩展与单图场景保持原有单图消息。
 */
export function buildPreviewAttachmentPayload(att: Attachment, group?: Attachment[]): PreviewAttachmentPayload {
  const base: PreviewAttachmentPayload = { name: att.name, mimeType: att.mimeType, data: att.data }
  if (!window.__GRAYCODE_HOST || !att.data || !group || group.length < 2) return base
  const images = group.filter(item => item.type === 'image' && typeof item.data === 'string' && item.data.length > 0)
  const index = images.findIndex(item => item.id === att.id)
  if (index < 0 || images.length < 2) return base
  const trimmed = trimPreviewGallery(images, index)
  if (trimmed.items.length < 2) return base
  return { gallery: trimmed.items.map(item => ({ name: item.name, mimeType: item.mimeType, data: item.data! })), index: trimmed.index }
}

export async function previewAttachment(att: Attachment, group?: Attachment[]) {
  if (!att.data) return
  await sendToExtension(MESSAGE_NAMES.previewAttachment, buildPreviewAttachmentPayload(att, group))
}

export interface WorkspaceInputFileAttachmentPayload {
  name: string
  size: number
  mimeType: string
  data: string
}

export interface ReadWorkspaceFileForInputResult {
  success: boolean
  path: string
  isText: boolean
  content?: string
  attachment?: WorkspaceInputFileAttachmentPayload
  error?: string
}

export async function readWorkspaceFileForInput(path: string, conversationId?: string | null) {
  return await sendToExtension<ReadWorkspaceFileForInputResult>(MESSAGE_NAMES.readWorkspaceFileForInput, {
    path,
    ...(conversationId ? { conversationId } : {})
  })
}

/** 粘贴进输入框的图片在工作区中的存放目录；写入接口会按需创建。 */
const PASTED_IMAGE_DIRECTORY = '.graycode/attachments'

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/x-icon': 'ico'
}

function pastedImageFileName(name: string, mimeType: string, now = new Date()): string {
  const extension = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0].slice(1).toLowerCase()
    || IMAGE_EXTENSION_BY_MIME[mimeType.toLowerCase()]
    || 'png'
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-${stamp}-${Math.random().toString(36).slice(2, 8)}.${extension}`
}

export interface PastedImagePayload {
  name: string
  mimeType: string
  data: string
}

/**
 * 把粘贴进输入框的图片写入工作区，返回相对路径。
 * 没有工作区（聊天模式）或宿主未提供该入口时返回 null，图片仍按附件发送。
 */
export async function savePastedImageToWorkspace(image: PastedImagePayload, conversationId?: string | null): Promise<string | null> {
  const path = `${PASTED_IMAGE_DIRECTORY}/${pastedImageFileName(image.name, image.mimeType)}`
  try {
    const result = await sendToExtension<{ success?: boolean; path?: string }>(MESSAGE_NAMES.saveImageToPath, {
      path,
      data: image.data,
      mimeType: image.mimeType,
      ...(conversationId ? { conversationId } : {})
    })
    return result?.success ? result.path || path : null
  } catch {
    return null
  }
}

export async function readWorkspaceTextFile(path: string) {
  return await sendToExtension<{ success: boolean; path: string; content: string; error?: string }>(
    MESSAGE_NAMES.readWorkspaceTextFile,
    { path }
  )
}

export async function showContextContent(payload: { title: string; content: string; language: string }) {
  return await sendToExtension(MESSAGE_NAMES.showContextContent, payload)
}
