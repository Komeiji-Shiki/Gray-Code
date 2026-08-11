/**
 * toolMeta 查询辅助（手写，稳定层）
 *
 * 从 __generated__/toolMeta.ts（由 scripts/generate-tool-meta.mjs 生成）读取后端
 * 工具声明的 description，供各工具注册文件的 descriptionFormatter 作兜底描述。
 * toolMeta 缺失/动态的工具返回 undefined，由调用方回退手写文案。
 */

import { toolMeta } from './__generated__/toolMeta'

/** 兜底描述的最大长度（UI 折叠态描述不宜过长） */
const MAX_FALLBACK_LENGTH = 80

function shortenDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_FALLBACK_LENGTH) return flat

  // 优先取第一个完整句子（英文 .!? 或中文 。！？ 结尾）
  const firstSentence = flat.match(/^.*?[.!?。！？](?:\s|$)/)?.[0]?.trim() ?? ''
  if (firstSentence && firstSentence.length <= MAX_FALLBACK_LENGTH) {
    return firstSentence
  }
  return `${flat.slice(0, MAX_FALLBACK_LENGTH - 1).trimEnd()}…`
}

/**
 * 取工具的后端声明描述（截短为适合工具卡片兜底展示的文本）。
 * 找不到（未登记 / descriptionDynamic）时返回 undefined。
 */
export function getToolMetaDescription(toolName: string): string | undefined {
  const description = toolMeta[toolName]?.description
  if (typeof description !== 'string' || description.length === 0) return undefined
  return shortenDescription(description)
}

/**
 * 取工具的后端声明参数摘要（参数名 → { type, description?, enum?, required? }）。
 * 找不到或参数为动态构造时返回 undefined。
 */
export function getToolMetaParameters(toolName: string): Record<string, {
  type: string
  description?: string
  enum?: string[]
  required?: boolean
}> | undefined {
  const meta = toolMeta[toolName]
  if (!meta || meta.parametersDynamic) return undefined
  return meta.parameters
}
