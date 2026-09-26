import { hasMessage, t } from '../../../i18n'
import { recordValue, toolImage } from '../../../utils/toolPresentation'

export type ResultRecord = Record<string, unknown>
export interface AutomationProps { args?: ResultRecord; result?: unknown; error?: string; status?: string; toolName?: string }
export const record = (value: unknown): ResultRecord => recordValue(value) ? value : {}
export const records = (value: unknown): ResultRecord[] => Array.isArray(value) ? value.filter(recordValue) : []
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
export const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
export const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
export function payload(result: unknown): ResultRecord {
  const envelope = record(result)
  return Object.prototype.hasOwnProperty.call(envelope, 'data') ? record(envelope.data) : envelope
}
export function actionLabel(value: unknown): string {
  const key = `components.tools.automation.actions.${text(value)}`
  return hasMessage(key) ? t(key) : text(value)
}
export function dimensions(value: unknown): string {
  const bounds = record(value)
  return numeric(bounds.width) !== undefined && numeric(bounds.height) !== undefined ? `${bounds.width} × ${bounds.height}` : ''
}
export function fileSize(value: unknown): string {
  const bytes = numeric(value)
  if (bytes === undefined || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 正常截图交给安全媒体组件；未知 MIME/损坏编码也不能在原始详情中展开成巨块文本。 */
export function safeAutomationResult(value: unknown, field = ''): unknown {
  if (typeof value === 'string' && value.startsWith('data:image/') && !toolImage(value)) return `[image: ${value.length} chars]`
  if (Array.isArray(value)) return value.map(item => safeAutomationResult(item, field))
  if (!recordValue(value)) return value
  if (toolImage(value)) return value
  const imageLike = field === 'screenshot' || typeof value.mimeType === 'string' && value.mimeType.startsWith('image/')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    imageLike && key === 'data' && typeof item === 'string' ? `[image: ${item.length} chars]` : safeAutomationResult(item, key)]))
}
