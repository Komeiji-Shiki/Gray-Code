/**
 * 楼层号 / 存档序号纯函数测试
 *
 * 覆盖：
 * - computeMessageFloorMap：user/assistant 消息依次占楼，tool 消息不占楼
 * - computeCheckpointFloorMap：按 timestamp 升序编号，同时间戳稳定排序
 */
import { describe, expect, test } from 'vitest'
import { computeMessageFloorMap, computePaginatedMessageFloorMap, computeCheckpointFloorMap } from '../messageListUtils'

describe('computeMessageFloorMap', () => {
  test('user/assistant 消息依次占楼，tool 消息不占楼', () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 't1', role: 'tool' },
      { id: 'u2', role: 'user' },
      { id: 't2', role: 'tool' },
      { id: 'a2', role: 'assistant' }
    ]

    const map = computeMessageFloorMap(messages)

    expect(map.get('u1')).toBe(1)
    expect(map.get('a1')).toBe(2)
    expect(map.has('t1')).toBe(false)
    expect(map.get('u2')).toBe(3)
    expect(map.has('t2')).toBe(false)
    expect(map.get('a2')).toBe(4)
  })

  test('总结消息（role=user + isSummary）计入楼层，保证连续', () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'sum1', role: 'user' },
      { id: 'u2', role: 'user' }
    ]

    const map = computeMessageFloorMap(messages)

    expect(map.get('sum1')).toBe(3)
    expect(map.get('u2')).toBe(4)
  })

  test('空列表返回空映射', () => {
    expect(computeMessageFloorMap([]).size).toBe(0)
  })

  test('工具响应虽然映射为 user 角色，也不占楼层', () => {
    const map = computeMessageFloorMap([
      { id: 'user', role: 'user' },
      { id: 'reply', role: 'user', isFunctionResponse: true },
      { id: 'model', role: 'assistant' }
    ])
    expect([...map.entries()]).toEqual([['user', 1], ['model', 2]])
  })
})

describe('computePaginatedMessageFloorMap', () => {
  const floorIndices = [0, 1, 3, 4, 7]
  const tail = [
    { id: 'u4', role: 'user', backendIndex: 4 },
    { id: 'tool5', role: 'user', isFunctionResponse: true, backendIndex: 5 },
    { id: 'a7', role: 'assistant', backendIndex: 7 }
  ]

  test('尾页、补拉较早页和跳转窗口使用相同的全局楼层', () => {
    expect([...computePaginatedMessageFloorMap(tail, floorIndices, 8).entries()]).toEqual([['u4', 4], ['a7', 5]])
    expect([...computePaginatedMessageFloorMap([
      { id: 'u3', role: 'user', backendIndex: 3 }, ...tail
    ], floorIndices, 8).entries()]).toEqual([['u3', 3], ['u4', 4], ['a7', 5]])
    expect(computePaginatedMessageFloorMap([tail[2]], floorIndices, 8).get('a7')).toBe(5)
  })

  test('新消息连续追加时顺延楼层，出现未加载的索引间隙时不猜测', () => {
    const appended = [
      tail[2],
      { id: 'u8', role: 'user', backendIndex: 8 },
      { id: 'tool9', role: 'user', isFunctionResponse: true, backendIndex: 9 },
      { id: 'a10', role: 'assistant', backendIndex: 10 }
    ]
    expect([...computePaginatedMessageFloorMap(appended, floorIndices, 8).entries()]).toEqual([
      ['a7', 5], ['u8', 6], ['a10', 7]
    ])
    expect(computePaginatedMessageFloorMap([tail[2], appended[3]], floorIndices, 8).has('a10')).toBe(false)
  })

  test('全局索引未返回时只给从历史起点开始的窗口编号', () => {
    expect(computePaginatedMessageFloorMap(tail, null, 0).size).toBe(0)
    expect(computePaginatedMessageFloorMap([
      { id: 'u0', role: 'user', backendIndex: 0 },
      { id: 'a1', role: 'assistant', backendIndex: 1 }
    ], null, 0).get('a1')).toBe(2)
  })

  test('同一条消息同时以本地占位和持久化形态出现时只占一格', () => {
    const messages = [
      tail[2],
      { id: 'u8', role: 'user' },
      { id: 'u8', role: 'user', backendIndex: 8 },
      { id: 'a9', role: 'assistant', backendIndex: 9 }
    ]
    const map = computePaginatedMessageFloorMap(messages, floorIndices, 8)
    expect(map.get('a7')).toBe(5)
    expect(map.get('u8')).toBe(6)
    // 已有占位编号时不再多占一格，后续新消息的号也不会被顶到前一位
    expect(map.get('a9')).toBe(7)
  })
})

describe('computeCheckpointFloorMap', () => {
  test('按 timestamp 升序编号', () => {
    const checkpoints = [
      { id: 'cp-3', timestamp: 3000, messageIndex: 3, phase: 'after' },
      { id: 'cp-1', timestamp: 1000, messageIndex: 1, phase: 'before' },
      { id: 'cp-2', timestamp: 2000, messageIndex: 2, phase: 'after' }
    ]

    const map = computeCheckpointFloorMap(checkpoints)

    expect(map.get('cp-1')).toBe(1)
    expect(map.get('cp-2')).toBe(2)
    expect(map.get('cp-3')).toBe(3)
  })

  test('同时间戳按 messageIndex 升序、before 先于 after 稳定排序', () => {
    const checkpoints = [
      { id: 'cp-b2', timestamp: 1000, messageIndex: 2, phase: 'before' },
      { id: 'cp-a1', timestamp: 1000, messageIndex: 1, phase: 'after' },
      { id: 'cp-b1', timestamp: 1000, messageIndex: 1, phase: 'before' }
    ]

    const map = computeCheckpointFloorMap(checkpoints)

    expect(map.get('cp-b1')).toBe(1)
    expect(map.get('cp-a1')).toBe(2)
    expect(map.get('cp-b2')).toBe(3)
  })

  test('空列表返回空映射', () => {
    expect(computeCheckpointFloorMap([]).size).toBe(0)
  })
})
