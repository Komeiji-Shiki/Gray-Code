import { hasMessage, t } from '../i18n'
import { getToolDescription } from './toolLocalization'

export function toolIcon(name: string): string {
  if (name.startsWith('browser_')) return 'codicon-globe'
  if (name.startsWith('computer_')) return 'codicon-device-desktop'
  if (name.startsWith('team_') || name === 'agent_send_message') return 'codicon-organization'
  if (name.startsWith('memory_')) return 'codicon-book'
  if (name.startsWith('context_') || name === 'new_context') return 'codicon-note'
  if (name === 'ask_user') return 'codicon-comment-discussion'
  if (name === 'search_files') return 'codicon-search'
  if (name === 'workspace_files') return 'codicon-files'
  if (name === 'run_command' || name === 'process_session') return 'codicon-terminal'
  if (name === 'bot_read_attachment') return 'codicon-attach'
  if (name === 'show_windows_notification') return 'codicon-bell'
  if (name === 'pet_control') return 'codicon-smiley'
  return 'codicon-tools'
}

export function toolSummary(name: string, args: Record<string, unknown>): string {
  const target = ['query', 'url', 'path', 'command', 'title', 'name', 'text'].map(key => args?.[key])
    .find(value => typeof value === 'string' && value.trim()) as string | undefined
  return target?.replace(/\s+/g, ' ').slice(0, 180)
    || getToolDescription(name, t('components.message.tool.paramCount', { count: Object.keys(args ?? {}).length }))
}

export function toolFieldLabel(key: string): string {
  const message = `components.tools.structured.fields.${key}`
  return hasMessage(message) ? t(message) : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
}

export function toolStatusLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const message = `components.tools.structured.statuses.${value}`
  return hasMessage(message) ? t(message) : undefined
}

export function recordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

export function toolLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* 普通文本保持文本显示。 */ }
}

/** 仅使用工具已返回的图片字节，不在渲染结果时向外部地址发起图片请求。 */
export function toolImage(value: unknown): string | undefined {
  if (typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value
  if (!recordValue(value)) return undefined
  const image = recordValue(value.inlineData) ? value.inlineData : value
  if (typeof image.mimeType === 'string' && /^image\/(png|jpeg|webp|gif|avif)$/i.test(image.mimeType)
    && typeof image.data === 'string' && /^[a-z\d+/=\s]+$/i.test(image.data)) return `data:${image.mimeType};base64,${image.data}`
}

export function toolTextValue(value: unknown): unknown {
  if (!recordValue(value) || value.type !== 'text' || typeof value.text !== 'string') return value
  const text = value.text.trim()
  if (/^[{[]/.test(text)) {
    try { return JSON.parse(text) } catch { /* 非 JSON 的 MCP 正文照常展示。 */ }
  }
  return value.text
}

/** 原始数据只在展开时生成；图片和二进制保留大小说明，避免复制巨大的编码文本到 DOM。 */
export function toolRawData(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return `[${item.byteLength} bytes]`
    if (typeof item === 'string' && item.startsWith('data:image/')) return `[image: ${item.length} chars]`
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[circular]'
      seen.add(item)
      if (toolImage(item) && recordValue(item)) return { ...item, data: `[${String(item.data ?? '').length} chars]`, inlineData: undefined }
    }
    return item
  }, 2) ?? String(value)
}
