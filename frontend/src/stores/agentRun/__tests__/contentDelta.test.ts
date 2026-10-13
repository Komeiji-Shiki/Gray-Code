/**
 * contentDelta（SubAgent Monitor 实时 Content[] 投影）测试
 *
 * 覆盖：
 * - contentSnapshot 尾部是 model 消息 → 原位替换（Anthropic content_block_stop 结构校准）；
 * - contentSnapshot 尾部是工具结果（functionResponse）→ 必须新建下一轮 model 楼层，
 *   不得覆盖上一轮模型消息（回归：实时视图“运行中的内容突然换掉”）。
 * - delta 路径：尾部是非 model 楼层时新建 model 楼层（ensureLastModelContent）。
 */
import { describe, expect } from 'vitest'
import { reactive, toRaw } from 'vue'
import type { Content } from '../../../types'
import { applyStreamChunkToContents, applyStreamUpdatesToContents, getStreamContentChangeStart, isAppendOnlyStreamChange } from '../contentDelta'

test('响应式窗口与原始索引共享追加片段的变化边界', () => {
  const before = reactive([makeModelContent(0), makeModelContent(1)])
  const after = applyStreamChunkToContents(before, { delta: [{ text: ' a' }] })
  const latest = applyStreamChunkToContents(reactive(after), { delta: [{ text: ' b' }] })
  expect(getStreamContentChangeStart(toRaw(before), after)).toBe(1)
  expect(getStreamContentChangeStart(after, latest)).toBe(1)
  expect(isAppendOnlyStreamChange(before, reactive(latest))).toBe(true)
  const replaced = applyStreamChunkToContents(latest, makeSnapshot('权威正文'))
  expect(isAppendOnlyStreamChange(latest, replaced)).toBe(false)
  expect(isAppendOnlyStreamChange(replaced, applyStreamChunkToContents(replaced, { delta: [{ text: '继续' }] }))).toBe(true)
  expect(latest[0]).toBe(toRaw(before)[0])
  expect(latest[1].parts[0].text).toBe('model-1 a b')
})

function makeModelContent(index: number, text = `model-${index}`): Content {
  return {
    id: `m-${index}`,
    role: 'model',
    parts: [{ text }],
    index,
    timestamp: 1000 + index
  } as Content
}

function makeToolResultContent(index: number): Content {
  return {
    id: `fr-${index}`,
    role: 'user',
    isFunctionResponse: true,
    parts: [{ functionResponse: { id: `fr-${index}`, name: 'read_file', response: { ok: true } } }],
    index,
    timestamp: 1000 + index
  } as unknown as Content
}

function makeSnapshot(text: string, index?: number): Record<string, unknown> {
  return {
    contentSnapshot: {
      role: 'model',
      parts: [{ text }],
      ...(typeof index === 'number' ? { index } : {})
    }
  }
}

describe('applyStreamChunkToContents contentSnapshot', () => {
  test('同批 delta、权威快照和后续delta按顺序合并，工具结果后的新楼层不覆盖旧回复', () => {
    const contents = [makeModelContent(10, '已完成调用'), makeToolResultContent(11)]
    const next = applyStreamUpdatesToContents(contents, [
      { chunk: { delta: [{ text: '临时前缀' }] }, timestamp: 2000 },
      { chunk: makeSnapshot('权威正文') as { contentSnapshot: Content }, timestamp: 2001 },
      { chunk: { delta: [{ text: '，继续输出' }], usage: { candidatesTokenCount: 12 } }, timestamp: 2002 },
    ], 10)
    expect(next).toHaveLength(3)
    expect(next[0]).toBe(contents[0])
    expect(next[1]).toBe(contents[1])
    expect(next[2]).toMatchObject({ index: 12, parts: [{ text: '权威正文，继续输出' }],
      usageMetadata: { candidatesTokenCount: 12 } })
    expect(contents[0].parts[0].text).toBe('已完成调用')
  })

  test('尾部就是 model 消息时原位替换（结构校准）', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'task' }], index: 0, timestamp: 1000 } as Content,
      makeModelContent(1, 'tool call')
    ]
    const next = applyStreamChunkToContents(contents, makeSnapshot('recalibrated'), 2000, 0)
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(contents[0])
    expect(next[1].parts).toEqual([{ text: 'recalibrated' }])
    expect((next[1] as any).index).toBe(1)
  })

  test('尾部是工具结果时追加新的 model 楼层，不覆盖上一轮模型消息（回归）', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'task' }], index: 0, timestamp: 1000 } as Content,
      makeModelContent(1, 'tool call'),
      makeToolResultContent(2)
    ]
    const next = applyStreamChunkToContents(contents, makeSnapshot('final answer'), 3000, 0)
    expect(next).toHaveLength(4)
    // 上一轮模型消息与工具结果原样保留
    expect(next[1].parts).toEqual([{ text: 'tool call' }])
    expect((next[2] as any).isFunctionResponse).toBe(true)
    // 新楼层携带正确的绝对 index
    expect(next[3].role).toBe('model')
    expect(next[3].parts).toEqual([{ text: 'final answer' }])
    expect((next[3] as any).index).toBe(3)
  })

  test('baseIndex 非零时新楼层 index 与窗口起始对齐', () => {
    const contents: Content[] = [
      makeModelContent(10, 'tool call'),
      makeToolResultContent(11)
    ]
    const next = applyStreamChunkToContents(contents, makeSnapshot('final answer'), 3000, 10)
    expect(next).toHaveLength(3)
    expect((next[2] as any).index).toBe(12)
  })

  test('没有 model 楼层时追加（与旧行为一致）', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'task' }], index: 0, timestamp: 1000 } as Content,
      makeToolResultContent(1)
    ]
    const next = applyStreamChunkToContents(contents, makeSnapshot('answer'), 2000, 0)
    expect(next).toHaveLength(3)
    expect(next[2].role).toBe('model')
    expect((next[2] as any).index).toBe(2)
  })
})

describe('applyStreamChunkToContents delta', () => {
  test('尾部是工具结果时 delta 新建 model 楼层并追加文本', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'task' }], index: 0, timestamp: 1000 } as Content,
      makeModelContent(1, 'tool call'),
      makeToolResultContent(2)
    ]
    const next = applyStreamChunkToContents(contents, { delta: [{ text: 'run' }, { text: 'ning' }] }, 3000, 0)
    expect(next).toHaveLength(4)
    expect(next[1].parts).toEqual([{ text: 'tool call' }])
    expect(next[3].parts).toEqual([{ text: 'running' }])
    expect((next[3] as any).index).toBe(3)
  })
})
