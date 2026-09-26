import { hasMessage, t } from '../../../i18n'
import { recordValue } from '../../../utils/toolPresentation'

export interface PlatformToolProps {
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  status?: string
  toolName?: string
}

export const object = (value: unknown): Record<string, unknown> => recordValue(value) ? value : {}
export const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(recordValue) : []
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
export const text = (value: unknown): string => typeof value === 'string' ? value : ''
export const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
export const resultBody = (value: unknown): unknown => recordValue(value) && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value
export const pick = (value: unknown, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(object(value)).filter(([key, item]) => keys.includes(key) && item !== undefined))
export const successfulResult = (props: PlatformToolProps): boolean => object(props.result).success === true
  && !object(props.result).error && !props.error && !['error', 'failed', 'cancelled'].includes(props.status ?? '')

/** 协议枚举翻译，未知的新值保持原样；不把缺失数据推断为成功。 */
export function label(section: string, value: unknown): string {
  if (typeof value !== 'string') return ''
  const key = `components.tools.platform.${section}.${value}`
  return hasMessage(key) ? t(key) : value
}
