/**
 * monitorWindowState 测试（P3：工具调用触发的尾部刷新不得清掉用户已加载的更早历史）
 *
 * 覆盖：
 * - prependRunContentWindow：加载更早消息只前置不替换尾部；
 * - replaceRunContentWindowPreservingPrefix：尾部校准窗口保留已 prepend 的前缀，
 *   没有前缀时退化为纯 replace；
 * - 过期校准窗口不会覆盖新窗口（freshness 判断）。
 */
import { describe, expect } from 'vitest'
import type { Content } from '../../../types'
import {
  createPreviousRunWindowRequestOptions,
  isRunContentWindowStale,
  prependRunContentWindow,
  replaceRunContentWindow,
  replaceRunContentWindowPreservingPrefix,
  type SubAgentRunContentWindowState
} from '../monitorWindowState'

function makeContent(index: number, text = `msg-${index}`): Content {
  return {
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text }],
    index,
    timestamp: 1000 + index
  } as Content
}

function makeWindow(overrides: Partial<SubAgentRunContentWindowState>): SubAgentRunContentWindowState {
  return {
    runId: 'run_1',
    contents: [],
    startIndex: 0,
    endIndex: 0,
    totalCount: 0,
    contentRevision: 0,
    eventSequence: 0,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...overrides
  }
}

describe('prependRunContentWindow（加载更早消息）', () => {
  test('只前置尚未覆盖的更早内容，尾部对象引用保持不变', () => {
    const tail = makeWindow({
      contents: [makeContent(0), makeContent(1)],
      startIndex: 0,
      endIndex: 2,
      totalCount: 5,
      contentRevision: 2,
      hasMoreBefore: true
    })
    const older = makeWindow({
      contents: [makeContent(-2), makeContent(-1)],
      startIndex: -2,
      endIndex: 0,
      totalCount: 5,
      contentRevision: 2,
      hasMoreBefore: true
    })

    const merged = prependRunContentWindow(tail, older)!
    expect(merged.contents).toHaveLength(4)
    expect(merged.contents[0].index).toBe(-2)
    expect(merged.contents[1].index).toBe(-1)
    // 尾部原对象引用保留（不触发 MessageItem 重渲染）
    expect(merged.contents[2]).toBe(tail.contents[0])
    expect(merged.contents[3]).toBe(tail.contents[1])
    expect(merged.startIndex).toBe(-2)
    expect(merged.endIndex).toBe(2)
    expect(merged.hasMoreBefore).toBe(true)
  })
})

describe('replaceRunContentWindowPreservingPrefix（P3 尾部刷新保持窗口）', () => {
  test('用户已加载更早历史后，新的尾部校准窗口保留前缀', () => {
    // 当前窗口：前缀（用户 prepend 的更早消息）+ 旧尾部
    const current = makeWindow({
      contents: [makeContent(-2), makeContent(-1), makeContent(0), makeContent(1)],
      startIndex: -2,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 2,
      hasMoreBefore: true
    })
    // 工具调用后后端返回的最新尾部窗口（revision 推进）
    const incoming = makeWindow({
      contents: [makeContent(0, 'msg-0-v2'), makeContent(1, 'msg-1-v2')],
      startIndex: 0,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 3,
      hasMoreBefore: false
    })

    const merged = replaceRunContentWindowPreservingPrefix(incoming, current)!
    // 前缀保留 + 尾部换成权威内容
    expect(merged.contents).toHaveLength(4)
    expect(merged.contents[0].index).toBe(-2)
    expect(merged.contents[1].index).toBe(-1)
    expect(merged.contents[0]).toBe(current.contents[0])
    expect(merged.contents[1]).toBe(current.contents[1])
    expect(merged.contents[2]).toBe(incoming.contents[0])
    expect(merged.contents[3]).toBe(incoming.contents[1])
    expect(merged.startIndex).toBe(-2)
    expect(merged.endIndex).toBe(2)
    expect(merged.totalCount).toBe(4)
    expect(merged.contentRevision).toBe(3)
    // 前缀还在，往前加载能力沿用前缀窗口的信息
    expect(merged.hasMoreBefore).toBe(true)
  })

  test('没有前缀时退化为纯 replace（不制造重复）', () => {
    const current = makeWindow({
      contents: [makeContent(0), makeContent(1)],
      startIndex: 0,
      endIndex: 2,
      totalCount: 2,
      contentRevision: 1
    })
    const incoming = makeWindow({
      contents: [makeContent(0, 'v2'), makeContent(1, 'v2')],
      startIndex: 0,
      endIndex: 2,
      totalCount: 2,
      contentRevision: 2
    })

    const merged = replaceRunContentWindowPreservingPrefix(incoming, current)!
    expect(merged.contents).toHaveLength(2)
    expect(merged.contents[0]).toBe(incoming.contents[0])
    expect(merged.startIndex).toBe(0)
  })

  test('过期校准窗口不能覆盖新窗口（freshness 判断仍生效）', () => {
    const current = makeWindow({
      contents: [makeContent(-2), makeContent(-1), makeContent(0), makeContent(1)],
      startIndex: -2,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 3
    })
    const stale = makeWindow({
      contents: [makeContent(0), makeContent(1)],
      startIndex: 0,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 2
    })

    expect(replaceRunContentWindowPreservingPrefix(stale, current)).toBe(current)
    expect(replaceRunContentWindow(stale, current)).toBe(current)
  })

  test('旧版本纯 replace 语义仍会清掉前缀（回归对照：证明 preserve 版本必要）', () => {
    const current = makeWindow({
      contents: [makeContent(-2), makeContent(-1), makeContent(0), makeContent(1)],
      startIndex: -2,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 2
    })
    const incoming = makeWindow({
      contents: [makeContent(0, 'v2'), makeContent(1, 'v2')],
      startIndex: 0,
      endIndex: 2,
      totalCount: 4,
      contentRevision: 3
    })

    const replaced = replaceRunContentWindow(incoming, current)!
    expect(replaced.contents).toHaveLength(2)
    expect(replaced.startIndex).toBe(0)
  })
})

describe('createPreviousRunWindowRequestOptions', () => {
  test('以当前窗口 startIndex 为锚点向前取一页', () => {
    const current = makeWindow({ startIndex: -5 })
    expect(createPreviousRunWindowRequestOptions(current, 20)).toEqual({
      limit: 20,
      endIndex: -5
    })
  })
})

// 以下用例由 test/unit/frontend/components/subagents/monitorWindowState.test.ts 归位合并（断言/用例零改动）
function windowState(overrides: Partial<SubAgentRunContentWindowState> = {}): SubAgentRunContentWindowState {
  return {
    runId: 'run_1',
    contents: [],
    startIndex: 0,
    endIndex: 5,
    totalCount: 5,
    contentRevision: 3,
    eventSequence: 10,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...overrides
  }
}

describe('isRunContentWindowStale', () => {
  test('没有窗口时必须拉取', () => {
    expect(isRunContentWindowStale(undefined, { contentRevision: 1, contentCount: 1 })).toBe(true)
  })

  test('没有 manifest 时不主动拉取（没有任何证据表明窗口已过期）', () => {
    expect(isRunContentWindowStale(windowState(), undefined)).toBe(false)
  })

  test('manifest 修订号领先时判定为过期', () => {
    expect(isRunContentWindowStale(windowState({ contentRevision: 3 }), { contentRevision: 4 })).toBe(true)
  })

  test('修订号相同则不拉取——tool_started 这类纯状态事件不会触发窗口请求', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: 7, totalCount: 12 }),
      { contentRevision: 7, contentCount: 12 }
    )).toBe(false)
  })

  test('本地 live delta 让窗口修订号领先于 manifest 时，不回头拉旧窗口', () => {
    expect(isRunContentWindowStale(windowState({ contentRevision: 9 }), { contentRevision: 8 })).toBe(false)
  })

  test('修订号相同但后端条数更多时仍判定为过期', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: 5, totalCount: 20 }),
      { contentRevision: 5, contentCount: 21 }
    )).toBe(true)
  })

  test('缺失协议字段按 0 处理，不会把新窗口误判为过期', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: undefined, totalCount: 3 }),
      { contentCount: 3 }
    )).toBe(false)
  })
})
