/**
 * 工具结果合并工具。
 *
 * 工具卡片渲染需要「tool.result（工具调用方落盘的结果）」与「functionResponse
 * （后端真实执行返回、含 reload 后结果与后续确认字段）」合并展示；
 * 该逻辑此前在 MessageList / MessageTaskCards / todoList 三处重复实现（语义分叉：
 * 有的永远合并、有的优先单边）。这里收敛为单一实现：
 * - 两侧都存在 → 合并（response 覆盖 result 同名字段）；
 * - 仅一侧 → 返回该侧；
 * - 两侧皆无 → undefined（调用方按需回退 {}）。
 */

import type { ToolUsage } from '../types'

export function mergeToolResult(
  tool: ToolUsage,
  resolveToolResponseById?: (toolCallId: string) => unknown
): Record<string, unknown> | undefined {
  const fromTool = tool.result && typeof tool.result === 'object'
    ? tool.result as Record<string, unknown>
    : undefined

  const fromResponseRaw = tool.id && resolveToolResponseById
    ? resolveToolResponseById(tool.id)
    : undefined
  const fromResponse = fromResponseRaw && typeof fromResponseRaw === 'object'
    ? fromResponseRaw as Record<string, unknown>
    : undefined

  if (fromTool && fromResponse) {
    return { ...fromTool, ...fromResponse }
  }

  return fromResponse || fromTool
}
