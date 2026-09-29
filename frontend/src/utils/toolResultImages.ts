import type { ContentPart } from '../types'

// 历史响应以对象替换更新，按响应和 parts 引用复用投影，避免其他工具输出时重建图片结果。
const projections = new WeakMap<Record<string, unknown>, WeakMap<readonly ContentPart[], { id: string; result: Record<string, unknown> }>>()

/** 仅供界面投影：相邻图片属于前面的工具回执，原始消息与响应保持不变。 */
export function projectToolResultImages(
  response: Record<string, unknown> | null | undefined,
  parts: readonly (ContentPart & { displayName?: string })[] | undefined,
  toolCallId: string
) {
  if (!response || !parts || Array.isArray(response.multimodal) && response.multimodal.length
    || Array.isArray(response.attachments) && response.attachments.length) return response
  const cached = projections.get(response)?.get(parts)
  if (cached?.id === toolCallId) return cached.result
  let start = parts.length - 1
  while (start >= 0 && parts[start].functionResponse?.id !== toolCallId) start--
  if (start < 0) return response
  const images: Array<{ mimeType: string; data: string; name?: string }> = []
  for (let index = start + 1; index < parts.length; index++) {
    const part = parts[index]
    if (part.functionResponse || part.functionCall) break
    const image = part.inlineData
    if (image?.mimeType.startsWith('image/')) images.push({ mimeType: image.mimeType, data: image.data,
      name: image.name ?? image.displayName ?? part.displayName })
  }
  if (!images.length) return response
  const projected = { ...response, multimodal: images }
  let byParts = projections.get(response)
  if (!byParts) { byParts = new WeakMap(); projections.set(response, byParts) }
  byParts.set(parts, { id: toolCallId, result: projected })
  return projected
}
