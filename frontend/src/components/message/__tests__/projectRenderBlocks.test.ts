/**
 * projectRenderBlocks：索引化匹配 / 跨块去重与旧的线性实现结果一致，
 * 且未变化的工具条目、工具块在重算后复用引用（MessageRenderBlock 的 v-memo 依赖 block.tools 引用）。
 */
import { describe, expect, test } from 'vitest'
import type { ContentPart, Message, ToolUsage } from '../../../types'
import type { RenderBlock } from '../renderBlocks'
import { projectRenderBlocks } from '../messageItem/projectRenderBlocks'
import { buildFunctionCallToolRenderEntry, upsertToolRenderEntry } from '../../../utils/toolRenderEntries'

type ProjectedMessage = Pick<Message, 'id' | 'parts' | 'tools'>

/** 重构前 MessageContent.renderBlocks 的投影部分（逐字保留线性搜索），作为对照基准。 */
function legacyProject(message: ProjectedMessage): RenderBlock[] {
  const parts = message.parts
  if (!parts || parts.length === 0) return []
  const blocks: RenderBlock[] = []
  let currentTextBlock: string[] = []
  let currentToolBlock: ToolUsage[] = []
  let currentThoughtBlock: string[] = []
  let currentTextPartIndex = -1
  let currentTextPartCount = 0
  let currentThoughtPartIndex = -1
  let currentThoughtPartCount = 0
  const messageTools = message.tools || []
  let functionCallOrdinal = 0
  const flushText = () => {
    if (currentTextBlock.length > 0) {
      const text = currentTextBlock.join('')
      if (text.trim()) {
        blocks.push({ type: 'text', text, key: `${blocks.length}:text`, partKey: `text:${currentTextPartIndex}`, partCount: currentTextPartCount })
      }
      currentTextBlock = []
      currentTextPartIndex = -1
      currentTextPartCount = 0
    }
  }
  const flushTools = () => {
    if (currentToolBlock.length > 0) {
      blocks.push({ type: 'tool', tools: [...currentToolBlock], key: `${blocks.length}:tool:${currentToolBlock.map(tool => tool.id).join('|')}` })
      currentToolBlock = []
    }
  }
  const flushThought = () => {
    if (currentThoughtBlock.length > 0) {
      const text = currentThoughtBlock.join('')
      if (text.trim()) {
        blocks.push({ type: 'thought', text, key: `${blocks.length}:thought`, partKey: `thought:${currentThoughtPartIndex}`, partCount: currentThoughtPartCount })
      }
      currentThoughtBlock = []
      currentThoughtPartIndex = -1
      currentThoughtPartCount = 0
    }
  }
  const upsertToolAcrossRenderedBlocks = (entry: ToolUsage) => {
    const currentIndex = currentToolBlock.findIndex(tool => tool.id === entry.id)
    if (currentIndex !== -1) {
      upsertToolRenderEntry(currentToolBlock, entry)
      return
    }
    for (const block of blocks) {
      if (block.type !== 'tool' || !block.tools) continue
      if (block.tools.some(tool => tool.id === entry.id)) {
        upsertToolRenderEntry(block.tools, entry)
        return
      }
    }
    upsertToolRenderEntry(currentToolBlock, entry)
  }
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    if (part.thought && part.text) {
      flushText()
      flushTools()
      currentThoughtBlock.push(part.text)
      currentThoughtPartIndex = partIndex
      currentThoughtPartCount += 1
      continue
    }
    if (part.text) {
      flushThought()
      flushTools()
      currentTextBlock.push(part.text)
      currentTextPartIndex = partIndex
      currentTextPartCount += 1
    }
    if (part.functionCall) {
      flushText()
      flushThought()
      upsertToolAcrossRenderedBlocks(buildFunctionCallToolRenderEntry({
        messageId: message.id,
        functionCall: part.functionCall,
        messageTools,
        functionCallOrdinal
      }))
      functionCallOrdinal += 1
    }
  }
  flushThought()
  flushText()
  flushTools()
  return blocks
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成带重复 id、itemId/index 匹配、序位回退、迟到占位与夹在中间的文本/思考片段的消息。 */
function randomMessage(random: () => number): ProjectedMessage {
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]
  const ids = ['call_a', 'call_b', 'call_c', 'tmp_1', 'tmp_2', '', ' call_a ']
  const names = ['read_file', 'search', 'execute_command']
  const tools: ToolUsage[] = []
  const toolCount = Math.floor(random() * 6)
  for (let i = 0; i < toolCount; i++) {
    tools.push({
      id: pick(['call_a', 'call_b', 'call_c', 'call_d', 'call_a']),
      name: pick(names),
      args: random() < 0.5 ? { path: `f${i}` } : {},
      status: pick(['streaming', 'executing', 'success', 'error', 'awaiting_approval', undefined]) as ToolUsage['status'],
      result: random() < 0.3 ? { ok: i } : undefined,
      ...(random() < 0.4 ? { itemId: pick(['item_1', 'item_2', ' item_1 ']) } : {}),
      ...(random() < 0.4 ? { index: pick([0, 1, 2, Number.NaN]) } : {})
    } as ToolUsage)
  }
  const parts: ContentPart[] = []
  const partCount = 1 + Math.floor(random() * 14)
  for (let i = 0; i < partCount; i++) {
    const roll = random()
    if (roll < 0.25) parts.push({ text: pick(['hello ', 'world', '  ', 'more text']) })
    else if (roll < 0.35) parts.push({ text: pick(['thinking', 'plan']), thought: true })
    else {
      parts.push({
        functionCall: {
          id: pick(ids),
          name: pick(names),
          args: random() < 0.5 ? { path: `f${Math.floor(random() * 3)}` } : {},
          ...(random() < 0.3 ? { partialArgs: '{"pa' } : {}),
          ...(random() < 0.3 ? { itemId: pick(['item_1', 'item_2', '']) } : {}),
          ...(random() < 0.3 ? { index: pick([0, 1, 2, Number.NaN]) } : {})
        }
      } as ContentPart)
    }
  }
  return { id: 'msg', parts, tools }
}

describe('projectRenderBlocks', () => {
  test('matches the legacy linear projection on randomized tool streams', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const message = randomMessage(createRandom(seed))
      try {
        expect(projectRenderBlocks(message)).toEqual(legacyProject(message))
      } catch (error) {
        throw new Error(`seed ${seed} diverged: ${String(error)}`)
      }
    }
  })

  test('still matches the legacy projection when reusing the previous result', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = createRandom(seed)
      const message = randomMessage(random)
      const previous = projectRenderBlocks(message)
      // 追加正文并随机替换一个工具的状态对象，模拟流式重算。
      const tools = message.tools!.map(tool => (random() < 0.3 ? { ...tool, status: 'success' as const } : tool))
      const next: ProjectedMessage = { ...message, tools, parts: [...message.parts!, { text: 'delta' }] }
      expect(projectRenderBlocks(next, previous)).toEqual(legacyProject(next))
    }
  })

  test.each([
    ['NaN index never matches (=== semantics)', { index: Number.NaN }, { index: Number.NaN }, 'call_ordinal'],
    ['first tool wins for a duplicated itemId', { itemId: ' item_1 ' }, { itemId: 'item_1' }, 'call_item']
  ])('keeps find() semantics: %s', (_label, partFields, toolFields, expectedId) => {
    const tools = [
      { id: 'call_ordinal', name: 'search', args: {} } as ToolUsage,
      { id: 'call_item', name: 'search', args: {}, ...toolFields } as ToolUsage,
      { id: 'call_item_dup', name: 'search', args: {}, ...toolFields } as ToolUsage
    ]
    const message: ProjectedMessage = {
      id: 'msg',
      tools,
      parts: [{ functionCall: { id: 'tmp', name: 'search', args: {}, ...partFields } }] as ContentPart[]
    }
    const blocks = projectRenderBlocks(message)
    expect(blocks[0].tools![0].id).toBe(expectedId)
    expect(blocks).toEqual(legacyProject(message))
  })

  test('deduplicates a tool whose placeholder and final part are separated by text', () => {
    const message: ProjectedMessage = {
      id: 'msg',
      tools: [{ id: 'call_final', name: 'search', args: { q: 'x' }, status: 'success', result: { hits: 1 } } as ToolUsage],
      parts: [
        { functionCall: { id: 'call_final', name: 'search', args: {} } },
        { text: 'between' },
        { functionCall: { id: 'call_final', name: 'search', args: { q: 'x' } } }
      ] as ContentPart[]
    }
    const blocks = projectRenderBlocks(message)
    expect(blocks.map(block => block.type)).toEqual(['tool', 'text'])
    expect(blocks[0].tools).toHaveLength(1)
    expect(blocks[0].tools![0]).toMatchObject({ id: 'call_final', args: { q: 'x' }, status: 'success' })
  })

  test('reuses unchanged tool blocks and entries when only the text grows', () => {
    const tools: ToolUsage[] = [
      { id: 'call_1', name: 'read_file', args: { path: 'a' }, status: 'success', result: { ok: true } } as ToolUsage,
      { id: 'call_2', name: 'search', args: { q: 'b' }, status: 'executing' } as ToolUsage
    ]
    const baseParts = [
      { functionCall: { id: 'call_1', name: 'read_file', args: tools[0].args } },
      { text: 'middle' },
      { functionCall: { id: 'call_2', name: 'search', args: tools[1].args } },
      { text: 'tail' }
    ] as ContentPart[]
    const first = projectRenderBlocks({ id: 'msg', tools, parts: baseParts })

    const grown = [...baseParts.slice(0, 3), { text: 'tail grows' }] as ContentPart[]
    const second = projectRenderBlocks({ id: 'msg', tools, parts: grown }, first)
    expect(second[0]).toBe(first[0])
    expect(second[2]).toBe(first[2])
    expect(second[3]).not.toBe(first[3])

    // 第二个工具状态变化：只有该工具块更新，第一个工具块仍复用。
    const updatedTools = [tools[0], { ...tools[1], status: 'success', result: { hits: 2 } } as ToolUsage]
    const third = projectRenderBlocks({ id: 'msg', tools: updatedTools, parts: grown }, second)
    expect(third[0]).toBe(second[0])
    expect(third[2]).not.toBe(second[2])
    expect(third[2].tools![0]).toMatchObject({ status: 'success', result: { hits: 2 } })
  })

  test('reuses an unchanged entry inside a tool block that gained a new tool', () => {
    const tools = [{ id: 'call_1', name: 'read_file', args: { path: 'a' }, status: 'success' } as ToolUsage]
    const parts = [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a' } } }] as ContentPart[]
    const first = projectRenderBlocks({ id: 'msg', tools, parts })
    const second = projectRenderBlocks({
      id: 'msg',
      tools,
      parts: [...parts, { functionCall: { id: 'call_2', name: 'search', args: {} } }] as ContentPart[]
    }, first)
    // 块 key 随工具列表变化，块本身是新对象；未变的条目仍复用，ToolItem 的 tool prop 不变。
    expect(second[0]).not.toBe(first[0])
    expect(second[0].tools![0]).toBe(first[0].tools![0])
    expect(second[0].tools!.map(tool => tool.id)).toEqual(['call_1', 'call_2'])
  })
})
