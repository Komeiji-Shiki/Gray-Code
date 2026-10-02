/**
 * MessageContent 的 parts → 渲染块投影（纯函数，便于单测）。
 *
 * 连续的 text 块会合并，连续的 functionCall 块会合并成一个 tools 块；同一逻辑工具跨块去重。
 * 平滑流式尾块摘出与 text/thought 引用稳定化仍在组件内完成（依赖组件状态）。
 *
 * 性能：
 * - message.tools 一次建索引，functionCall 匹配不再逐个线性 find；
 * - 跨块去重用工具 ID → 位置索引，不再每次扫描全部已输出块（原实现为 parts × blocks × tools）；
 * - 正文 delta 会使投影整体重算，未变化的工具条目与工具块复用上次对象引用，
 *   使 MessageRenderBlock 的 v-memo（依赖 block.tools 引用）命中，工具卡不随正文重渲染。
 */
import type { Message, ToolUsage } from '../../../types'
import {
  buildFunctionCallToolRenderEntry,
  buildToolRenderLookup,
  isSameToolRenderEntry,
  mergeToolRenderEntry
} from '../../../utils/toolRenderEntries'
import type { RenderBlock } from '../renderBlocks'

interface ToolLocation {
  tools: ToolUsage[]
  index: number
}

export function projectRenderBlocks(
  message: Pick<Message, 'id' | 'parts' | 'tools'>,
  previousBlocks: readonly RenderBlock[] = []
): RenderBlock[] {
  const parts = message.parts
  if (!parts || parts.length === 0) return []

  const blocks: RenderBlock[] = []
  let currentTextBlock: string[] = []
  let currentToolBlock: ToolUsage[] = []
  let currentThoughtBlock: string[] = []
  // 块级段落身份（H2-B）：记录合并进当前块的最后一个 part 索引与 part 数量，
  // 与平滑显示层的 partKey 对齐，供流式期间按段落精确替换。
  let currentTextPartIndex = -1
  let currentTextPartCount = 0
  let currentThoughtPartIndex = -1
  let currentThoughtPartCount = 0

  const messageTools = message.tools || []
  const lookup = buildToolRenderLookup(messageTools)
  let functionCallOrdinal = 0
  /** 每个工具 ID 只会出现在一个块里（跨块去重保证），位置在追加后不再移动。 */
  const toolLocations = new Map<string, ToolLocation>()

  const previousToolEntries = new Map<string, ToolUsage>()
  const previousToolBlocks = new Map<string, RenderBlock>()
  for (const block of previousBlocks) {
    if (block.type !== 'tool' || !block.tools) continue
    if (block.key) previousToolBlocks.set(block.key, block)
    for (const tool of block.tools) {
      if (!previousToolEntries.has(tool.id)) previousToolEntries.set(tool.id, tool)
    }
  }

  // 辅助函数：刷新文本块
  const flushText = () => {
    if (currentTextBlock.length > 0) {
      const text = currentTextBlock.join('')
      if (text.trim()) {
        // 修改原因：流式正文每个 delta 都会改变 text.length；把长度/正文片段写进 key 会让 Vue 销毁重建 MarkdownRenderer，触发闪烁。
        // 修改方式：key 只表达结构身份（第几个 block + 类型），内容增长只通过 props 更新。
        // 修改目的：让主聊天与 Monitor 的流式文本块都复用同一组件实例，保留旧 HTML 直到新 HTML 渲染完成。
        blocks.push({ type: 'text', text, key: `${blocks.length}:text`, partKey: `text:${currentTextPartIndex}`, partCount: currentTextPartCount })
      }
      currentTextBlock = []
      currentTextPartIndex = -1
      currentTextPartCount = 0
    }
  }

  // 辅助函数：刷新工具块。数组直接交给 block（随后换新数组），toolLocations 中的引用保持有效，
  // 后续跨块 upsert 仍可按位置写回。
  const flushTools = () => {
    if (currentToolBlock.length > 0) {
      blocks.push({
        type: 'tool',
        tools: currentToolBlock,
        key: `${blocks.length}:tool:${currentToolBlock.map(tool => tool.id).join('|')}`
      })
      currentToolBlock = []
    }
  }

  // 辅助函数：刷新思考块
  const flushThought = () => {
    if (currentThoughtBlock.length > 0) {
      const text = currentThoughtBlock.join('')
      if (text.trim()) {
        // 修改原因：thought 与正文共享同一 RenderBlock 身份契约；思考内容增长也不应改变组件身份。
        blocks.push({ type: 'thought', text, key: `${blocks.length}:thought`, partKey: `thought:${currentThoughtPartIndex}`, partCount: currentThoughtPartCount })
      }
      currentThoughtBlock = []
      currentThoughtPartIndex = -1
      currentThoughtPartCount = 0
    }
  }

  const upsertToolAcrossRenderedBlocks = (entry: ToolUsage) => {
    // 为什么要跨 block 去重：流式快照/终结事件可能让同一逻辑工具的占位 part 和最终 part 中间夹着文本或思考片段，
    // 只在当前连续工具块里 upsert 仍会渲染成两张工具卡。
    const location = toolLocations.get(entry.id)
    if (location) {
      location.tools[location.index] = mergeToolRenderEntry(location.tools[location.index], entry)
      return
    }
    toolLocations.set(entry.id, { tools: currentToolBlock, index: currentToolBlock.length })
    currentToolBlock.push(entry)
  }

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    // 处理思考内容
    if (part.thought && part.text) {
      // 思考内容：先刷新其他块
      flushText()
      flushTools()
      currentThoughtBlock.push(part.text)
      currentThoughtPartIndex = partIndex
      currentThoughtPartCount += 1
      continue
    }

    // 处理文本
    if (part.text) {
      // 文本块：先刷新思考块和工具块
      flushThought()
      flushTools()
      currentTextBlock.push(part.text)
      currentTextPartIndex = partIndex
      currentTextPartCount += 1
    }

    // 处理工具调用（即使同一个 part 有 thoughtSignature）
    if (part.functionCall) {
      // 工具调用：先刷新文本块和思考块
      flushText()
      flushThought()

      // 为什么工具渲染不再只按 functionCall.id 解析：pending 阶段可能同时存在临时占位 part 和最终 call_id part。
      const renderTool = buildFunctionCallToolRenderEntry({
        messageId: message.id,
        functionCall: part.functionCall,
        messageTools,
        functionCallOrdinal,
        lookup
      })

      upsertToolAcrossRenderedBlocks(renderTool)

      functionCallOrdinal += 1
    }
    // 忽略其他类型（如 inlineData、fileData 等，后续可扩展）
  }

  // 刷新剩余块
  flushThought()
  flushText()
  flushTools()

  // 引用复用放在全部 upsert 之后：跨块合并可能改写已输出块的条目。
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== 'tool' || !block.tools) continue
    let allReused = true
    for (let j = 0; j < block.tools.length; j++) {
      const previous = previousToolEntries.get(block.tools[j].id)
      if (previous && isSameToolRenderEntry(previous, block.tools[j])) {
        block.tools[j] = previous
      } else {
        allReused = false
      }
    }
    const previousBlock = block.key ? previousToolBlocks.get(block.key) : undefined
    if (
      allReused &&
      previousBlock?.tools &&
      previousBlock.tools.length === block.tools.length &&
      previousBlock.tools.every((tool, j) => tool === block.tools![j])
    ) {
      blocks[i] = previousBlock
    }
  }

  return blocks
}
