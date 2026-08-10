/**
 * MessageItem 渲染块类型与 v-memo 依赖辅助。
 * v-memo 必须与 v-for 位于同一组件元素；这里集中 key/deps 计算，MessageRenderBlock 只负责展示。
 */

import type { ToolUsage } from '../../types'

/**
 * 渲染块类型：与 MessageItem 中 parts 合并后的一致结构。
 */
export interface RenderBlock {
  type: 'text' | 'tool' | 'thought'
  text?: string
  tools?: ToolUsage[]
  key?: string
  /**
   * 段落身份（text/thought + 最后一个贡献 part 的索引）：
   * 与平滑显示层（smoothTexts）的 partKey 对齐，MessageItem 据此只替换匹配块。
   */
  partKey?: string
  /** 合并进本块的同类型 part 数量（合并块无法按段落粒度替换，平滑层跳过） */
  partCount?: number
}

/**
 * 思维链（思考块）三段式视图模式，对齐后台任务回流消息的三段式：
 * - collapsed：完全折叠，只保留头部标题行（不显示任何内容预览）
 * - medium：中展开，固定行数滚动查看（足以看清一部分当前思考内容）
 * - expanded：完全展开，完整渲染全部内容
 */
export type ThoughtViewMode = 'collapsed' | 'medium' | 'expanded'

/**
 * 为渲染块生成稳定 key，避免 v-memo 缓存跨元素错位。
 *
 * 修改原因：流式 text/thought 的内容会持续增长，key 若包含 text.length 或正文片段，Vue 会把同一段输出误判为新块并重建 MarkdownRenderer。
 * 修改方式：调用方优先提供结构 key；兜底也只使用类型/工具身份，不再从正文内容派生身份。
 * 修改目的：把“块是谁”和“块显示什么”分开，主聊天与 SubAgent Monitor 共享同一流式块身份契约。
 */
export function getRenderBlockKey(block: RenderBlock): string {
  if (block.key) {
    return block.key
  }

  if (block.type === 'tool') {
    return `tool:${(block.tools ?? []).map(tool => tool.id).join('|') || 'tool'}`
  }

  return `${block.type}:unkeyed`
}

/** 为 MessageRenderBlock 生成 v-memo 依赖数组；只放真正影响渲染输出的值。 */
export function getRenderBlockMemoDeps(
  block: RenderBlock,
  isStreaming: boolean,
  isUser: boolean,
  thoughtViewMode: ThoughtViewMode,
  isThinking: boolean,
  thinkingTimeDisplay: string | null,
  smoothDisplayActive = false,
): unknown[] {
  // 活动平滑块的字符由 CharFlow 手动写入宿主，block.text 不再影响 Vue 输出；
  // 因此不能让每次真实 delta 或低频快照使 v-memo 失效。
  if (block.type === 'tool') {
    return [block.type, block.tools, isStreaming, isUser]
  }

  if (block.type === 'thought') {
    return smoothDisplayActive
      ? [block.type, block.partKey, isStreaming, isUser, thoughtViewMode, isThinking, thinkingTimeDisplay, true]
      : [block.type, block.text ?? '', isStreaming, isUser, thoughtViewMode, isThinking, thinkingTimeDisplay, false]
  }

  return [block.type, block.text ?? '', isStreaming, isUser]
}
