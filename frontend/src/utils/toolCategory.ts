/**
 * 工具分类辅助（工具设置页与子代理工具白名单共用）。
 *
 * 分类值来自后端工具声明（tools.getTools 返回的 category 字段）；
 * 无分类的工具归入「其他」，MCP 外部工具归入「MCP 工具」。
 */

import { t } from '../i18n'

export interface CategorizedTool {
  name: string
  category?: string
}

const CATEGORY_NAME_PREFIX = 'components.settings.toolsSettings.categories.'

/** 分类显示名 i18n key 映射 */
const CATEGORY_NAME_KEYS: Record<string, string> = {
  file: `${CATEGORY_NAME_PREFIX}file`,
  search: `${CATEGORY_NAME_PREFIX}search`,
  terminal: `${CATEGORY_NAME_PREFIX}terminal`,
  lsp: `${CATEGORY_NAME_PREFIX}lsp`,
  media: `${CATEGORY_NAME_PREFIX}media`,
  plan: `${CATEGORY_NAME_PREFIX}plan`,
  todo: `${CATEGORY_NAME_PREFIX}todo`,
  history: `${CATEGORY_NAME_PREFIX}history`,
  memory: `${CATEGORY_NAME_PREFIX}memory`,
  review: `${CATEGORY_NAME_PREFIX}review`,
  progress: `${CATEGORY_NAME_PREFIX}progress`,
  skills: `${CATEGORY_NAME_PREFIX}skills`,
  design: `${CATEGORY_NAME_PREFIX}design`,
  notification: `${CATEGORY_NAME_PREFIX}notification`,
  agents: `${CATEGORY_NAME_PREFIX}agents`,
  activity: `${CATEGORY_NAME_PREFIX}activity`,
  mcp: `${CATEGORY_NAME_PREFIX}mcp`,
  other: `${CATEGORY_NAME_PREFIX}other`
}

/** 分类图标（codicon 类名）映射 */
const CATEGORY_ICONS: Record<string, string> = {
  file: 'codicon-file',
  search: 'codicon-search',
  terminal: 'codicon-terminal',
  lsp: 'codicon-symbol-class',
  media: 'codicon-file-media',
  plan: 'codicon-notebook',
  todo: 'codicon-checklist',
  history: 'codicon-history',
  memory: 'codicon-database',
  review: 'codicon-eye',
  progress: 'codicon-graph-line',
  skills: 'codicon-lightbulb',
  design: 'codicon-paintcan',
  notification: 'codicon-bell',
  agents: 'codicon-account',
  activity: 'codicon-watch',
  mcp: 'codicon-plug',
  other: 'codicon-extensions'
}

/** 规范化分类 key（未知 / 缺省分类统一归入 other） */
export function normalizeToolCategory(category: string | undefined): string {
  return category && CATEGORY_NAME_KEYS[category] ? category : 'other'
}

/** 按分类分组的工具（保持工具数组原有顺序，缺省分类归入 other） */
export function groupToolsByCategory<T extends CategorizedTool>(tools: T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {}
  for (const tool of tools) {
    const category = normalizeToolCategory(tool.category)
    if (!grouped[category]) {
      grouped[category] = []
    }
    grouped[category].push(tool)
  }
  return grouped
}

/** 分类显示名（i18n，未知分类回退「其他」） */
export function getCategoryName(category: string): string {
  const key = CATEGORY_NAME_KEYS[category] || CATEGORY_NAME_KEYS.other
  return t(key)
}

/** 分类图标（codicon 类名，未知分类回退 extensions） */
export function getCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category] || 'codicon-extensions'
}
