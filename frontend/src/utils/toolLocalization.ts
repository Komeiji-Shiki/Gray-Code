/**
 * 工具名称 / 描述的本地化辅助（工具设置页与子代理工具白名单共用）。
 *
 * i18n 条目位于 `components.settings.toolsSettings.toolDisplayNames.*` 与
 * `components.settings.toolsSettings.toolDescriptions.*`（三语同步维护）。
 *
 * - 显示名：优先 i18n；缺失时机械转换（snake_case → Title Case），
 *   MCP 外部工具（mcp__xxx）通常没有条目，走机械转换兜底。
 * - 描述：优先 i18n；缺失时回退后端声明原文（tool.description）。
 */

import { t, hasMessage } from '../i18n'
import { isMcpToolName, decodeMcpToolName } from './tools/mcp/mcpToolNameCodec'

const TOOL_DISPLAY_NAME_PREFIX = 'components.settings.toolsSettings.toolDisplayNames.'
const TOOL_DESCRIPTION_PREFIX = 'components.settings.toolsSettings.toolDescriptions.'

/** 机械转换：snake_case / kebab-case → Title Case（如 read_file → Read File） */
function toTitleCase(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * 工具显示名称（优先 i18n，fallback 机械转换）。
 * 用 hasMessage 预检避免 t() 对缺失 key 的 console.warn 刷屏（MCP 动态工具名几乎都无条目）。
 */
export function getToolDisplayName(name: string): string {
  // MCP 外部工具（mcp__<serverId>__<toolName>）：先解码出原始工具名再机械转换，
  // 避免把整条编码名（含 serverId）转成 "Mcp Mcp 1785407697930 ... Search" 这种不可读格式。
  // 解码失败（非标准格式）时回退到通用逻辑。
  if (isMcpToolName(name)) {
    const decoded = decodeMcpToolName(name)
    if (decoded) return toTitleCase(decoded.toolName)
  }
  const i18nKey = `${TOOL_DISPLAY_NAME_PREFIX}${name}`
  if (hasMessage(i18nKey)) return t(i18nKey)
  return toTitleCase(name)
}

/** 工具描述（优先 i18n，fallback 后端原文） */
export function getToolDescription(name: string, fallback: string): string {
  const i18nKey = `${TOOL_DESCRIPTION_PREFIX}${name}`
  if (hasMessage(i18nKey)) return t(i18nKey)
  return fallback
}
