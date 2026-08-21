/**
 * 楼层号 / 存档序号纯函数测试
 *
 * 覆盖：
 * - computeMessageFloorMap：user/assistant 消息依次占楼，tool 消息不占楼
 * - computeCheckpointFloorMap：按 timestamp 升序编号，同时间戳稳定排序
 */
import { describe, expect, test } from 'vitest'
import { computeMessageFloorMap, computeCheckpointFloorMap } from '../messageListUtils'

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
