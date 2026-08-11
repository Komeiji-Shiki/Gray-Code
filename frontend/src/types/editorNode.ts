/**
 * 编辑器节点类型
 * 用于表示输入框中的混合内容（文本和上下文徽章穿插）
 */

import type { PromptContextItem } from './promptContext'

/**
 * 编辑器节点 - 可以是文本或上下文徽章
 */
export type EditorNode = TextNode | ContextNode

/**
 * 文本节点
 */
export interface TextNode {
  type: 'text'
  text: string
}

/**
 * 上下文徽章节点
 */
export interface ContextNode {
  type: 'context'
  context: PromptContextItem
}

/**
 * 创建文本节点
 */
export function createTextNode(text: string): TextNode {
  return { type: 'text', text }
}

/**
 * 创建上下文节点
 */
export function createContextNode(context: PromptContextItem): ContextNode {
  return { type: 'context', context }
}

/**
 * 从节点数组中提取纯文本内容
 */
export function getPlainText(nodes: EditorNode[]): string {
  return nodes
    .filter((n): n is TextNode => n.type === 'text')
    .map(n => n.text)
    .join('')
}

/**
 * 从节点数组中提取所有上下文
 */
export function getContexts(nodes: EditorNode[]): PromptContextItem[] {
  return nodes
    .filter((n): n is ContextNode => n.type === 'context')
    .map(n => n.context)
}

/**
 * 将节点数组序列化为发送格式
 * 格式：文本部分保持原样，上下文以 <lim-context> 标签包裹并就地插入
 */
function escapeContextAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeContextContent(value: string): string {
  // 正文会原样发送给模型，只处理会提前闭合当前徽章或开启新徽章的标签序列，避免改变普通代码中的 <、>、&。
  // 开标签也要转义：仅转义闭标签时，正文里的 <lim-context ...> 会在解析侧被当作新的上下文块起点，
  // 造成“序列化 → 解析 → 再序列化”漂移（解析侧 decodeContextContent 同步还原两种转义）。
  // 开标签仅匹配后随空白或 > 的 <lim-context，避免误伤普通文本中的“<lim-context”字样。
  return value
    .replace(/<\/lim-context>/gi, '&lt;/lim-context&gt;')
    .replace(/<lim-context(?=[\s>])/gi, '&lt;lim-context')
}

export function serializeNodes(nodes: EditorNode[]): string {
  return nodes.map(node => {
    if (node.type === 'text') {
      return node.text
    } else {
      const ctx = node.context
      const attrs: string[] = [`type="${escapeContextAttribute(ctx.type)}"`]
      if (ctx.filePath) attrs.push(`path="${escapeContextAttribute(ctx.filePath)}"`)
      if (ctx.language) attrs.push(`language="${escapeContextAttribute(ctx.language)}"`)
      const isBinaryContext = ctx.isTextContent === false
      if (isBinaryContext) attrs.push('binary="true"')
      const title = escapeContextAttribute(ctx.title)
      const content = isBinaryContext ? '' : escapeContextContent(ctx.content)
      return `<lim-context ${attrs.join(' ')} title="${title}">\n${content}\n</lim-context>`
    }
  }).join('')
}

/**
 * 规范化节点数组：合并相邻的文本节点
 */
export function normalizeNodes(nodes: EditorNode[]): EditorNode[] {
  const result: EditorNode[] = []
  
  for (const node of nodes) {
    if (node.type === 'text') {
      const last = result[result.length - 1]
      if (last && last.type === 'text') {
        // 合并相邻文本节点
        last.text += node.text
      } else if (node.text) {
        // 只添加非空文本
        result.push({ ...node })
      }
    } else {
      result.push({ ...node })
    }
  }
  
  return result
}
