import { describe, expect, test } from 'vitest'
import { getMessageInputGroupPositions } from '../messageListUtils'
import type { Message } from '../../../types'

type Row = Parameters<typeof getMessageInputGroupPositions>[0][number]

function row(kind: 'user' | 'background' | 'agent' | 'assistant', id: string = kind): Row {
  const message: Message = {
    id, role: kind === 'assistant' ? 'assistant' : 'user', content: `${id} 原文`, timestamp: 0,
    ...(kind === 'background' ? { source: 'background_task' as const } : {}),
    ...(kind === 'agent' ? { source: 'agent_message' as const } : {})
  }
  return { kind: 'message', item: { message, beforeCheckpoints: [], afterCheckpoints: [] } }
}

const positions = getMessageInputGroupPositions

describe('相邻用户输入与后台回传的视觉连接', () => {
  test.each([
    ['background', 'background'], ['user', 'background'], ['background', 'user'], ['agent', 'user']
  ] as const)('%s-%s 保持逐条消息身份，只连接外观', (left, right) => {
    const rows = [row(left, 'first'), row(right, 'second')]
    const original = JSON.stringify(rows)
    expect(positions(rows)).toEqual(['start', 'end'])
    expect(JSON.stringify(rows)).toBe(original)
    expect(rows.map(item => item.item?.message.id)).toEqual(['first', 'second'])
  })

  test('user-background-user 为同一区，纯 user-user 不扩展', () => {
    expect(positions([row('user'), row('background'), row('user')])).toEqual(['start', 'middle', 'end'])
    expect(positions([row('user'), row('user')])).toEqual([undefined, undefined])
    expect(positions([row('user'), row('user'), row('background'), row('user'), row('user')]))
      .toEqual([undefined, 'start', 'middle', 'end', undefined])
  })

  test('助手、build/todo 与总结分隔行均隔断，不跨行连接', () => {
    for (const separator of [row('assistant'), { kind: 'build' }, { kind: 'todo' }, { kind: 'summarize-divider' }]) {
      expect(positions([row('background'), separator, row('background')])).toEqual(['single', undefined, 'single'])
    }
  })

  test('summary/context/工具响应保持特殊展示，不并入输入区', () => {
    const specialMessages: Partial<Message>[] = [
      { isSummary: true }, { contextMethod: 'notes' }, { contextWindowId: 'context-window' },
      { content: '<lim-context type="text">上下文</lim-context>' },
      { parts: [{ text: '<lim-context type="text">上下文</lim-context>' }] },
      { isFunctionResponse: true }, { role: 'tool' },
      { parts: [{ functionCall: { id: 'call', name: 'read_file', args: {} } }] }
    ]
    for (const special of specialMessages) {
      const separator = row('user')
      Object.assign(separator.item!.message, special)
      expect(positions([row('background'), separator, row('background')])).toEqual(['single', undefined, 'single'])
    }
  })

  test('相邻消息之间的 before/after 检查点阻断，区外检查点不吞入', () => {
    const before = [row('background'), row('user')]
    before[1].item!.beforeCheckpoints = [{}]
    expect(positions(before)).toEqual(['single', undefined])
    const after = [row('user'), row('background')]
    after[0].item!.afterCheckpoints = [{}]
    expect(positions(after)).toEqual([undefined, 'single'])

    const outside = [row('user'), row('background')]
    outside[0].item!.beforeCheckpoints = [{}]
    outside[1].item!.afterCheckpoints = [{}]
    expect(positions(outside)).toEqual(['start', 'end'])
  })

  test('同批长消息只扫描一次上下文 parts，不为左右邻居重复分类', () => {
    let reads = 0
    const middle = row('background')
    middle.item!.message.parts = Array.from({ length: 100 }, () => ({ get text() { reads++; return '较长原文' } }))
    expect(positions([row('background'), middle, row('user')])).toEqual(['start', 'middle', 'end'])
    expect(reads).toBe(100)
  })

  test('虚拟窗口首尾独立封口，不向未渲染消息延伸或增加行数', () => {
    const rows = [row('background', 'a'), row('background', 'b'), row('background', 'c')]
    expect(positions(rows)).toEqual(['start', 'middle', 'end'])
    expect(positions(rows.slice(1))).toEqual(['start', 'end'])
    expect(positions(rows.slice(1, 2))).toEqual(['single'])
    expect(rows).toHaveLength(3)
  })
})
