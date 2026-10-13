import type { ToolUsage } from '../../types'
import { decodeUnicodeEscapes } from '../../utils/format'

const LIVE_ARGUMENT_PREVIEW_STATUSES = new Set<ToolUsage['status']>([
  'streaming',
  'queued',
  'executing',
  'awaiting_approval'
])

/**
 * 判断工具是否仍应展示流式参数预览。
 *
 * 修改原因：流式提前执行让工具在参数最终快照落地前就进入 executing；旧逻辑把预览绑定到 status=streaming，导致工具刚开始执行时原始参数预览消失。
 * 修改方式：把“是否展示 partialArgs”从单一状态字段中拆出来，只要工具仍处于非终态并带有 partialArgs，就继续展示预览。
 * 修改目的：修复流式提前执行中的卡片预览消失，同时为后续把输入态和执行态拆成两个字段留下清晰边界。
 */
export function shouldShowToolArgumentPreview(tool: ToolUsage): boolean {
  return LIVE_ARGUMENT_PREVIEW_STATUSES.has(tool.status) && !!tool.partialArgs && tool.partialArgs.length > 0
}

/** 预览只保留最近的参数片段；完整参数仍由工具状态保存，避免长文件逐批解码和布局累计全文。 */
export function toolArgumentPreviewText(text: string): string {
  let start = Math.max(0, text.length - 4096)
  if (start === 0) return decodeUnicodeEscapes(text)

  // 裁剪点越过被截断的 Unicode 转义及反斜杠串，避免把字面量转义误当成新转义。
  const beforeStart = text.slice(Math.max(0, start - 5), start)
  const slash = beforeStart.lastIndexOf('\\')
  if (slash >= 0) {
    const escapeStart = start - beforeStart.length + slash
    if (/^\\u[0-9a-fA-F]{4}$/.test(text.slice(escapeStart, escapeStart + 6))) start = escapeStart + 6
  }
  while (text[start] === '\\') start++
  if (text[start - 1] === '\\' && /^u[0-9a-fA-F]{4}/.test(text.slice(start, start + 5))) start += 5
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++
  const tail = decodeUnicodeEscapes(text.slice(start))
  // 转义代理对也可能跨过裁剪点，只丢弃孤立的低代理位。
  return '…\n' + (tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff ? tail.slice(1) : tail)
}
