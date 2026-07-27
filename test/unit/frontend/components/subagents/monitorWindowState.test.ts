/**
 * SubAgent Monitor 窗口新鲜度判据测试。
 *
 * 覆盖 isRunContentWindowStale：它同时决定「事件到达后要不要重新拉窗口」和
 * 「切回此前看过的 run 时能不能直接用缓存」，判错任一方向都会直接被用户看到——
 * 要么工具调用把窗口请求打成风暴，要么切回去看到的是上次离开时的旧内容。
 */

import {
  isRunContentWindowStale,
  type SubAgentRunContentWindowState
} from '../../../../../frontend/src/components/subagents/monitorWindowState'

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
  it('没有窗口时必须拉取', () => {
    expect(isRunContentWindowStale(undefined, { contentRevision: 1, contentCount: 1 })).toBe(true)
  })

  it('没有 manifest 时不主动拉取（没有任何证据表明窗口已过期）', () => {
    expect(isRunContentWindowStale(windowState(), undefined)).toBe(false)
  })

  it('manifest 修订号领先时判定为过期', () => {
    expect(isRunContentWindowStale(windowState({ contentRevision: 3 }), { contentRevision: 4 })).toBe(true)
  })

  it('修订号相同则不拉取——tool_started 这类纯状态事件不会触发窗口请求', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: 7, totalCount: 12 }),
      { contentRevision: 7, contentCount: 12 }
    )).toBe(false)
  })

  it('本地 live delta 让窗口修订号领先于 manifest 时，不回头拉旧窗口', () => {
    expect(isRunContentWindowStale(windowState({ contentRevision: 9 }), { contentRevision: 8 })).toBe(false)
  })

  it('修订号相同但后端条数更多时仍判定为过期', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: 5, totalCount: 20 }),
      { contentRevision: 5, contentCount: 21 }
    )).toBe(true)
  })

  it('缺失协议字段按 0 处理，不会把新窗口误判为过期', () => {
    expect(isRunContentWindowStale(
      windowState({ contentRevision: undefined, totalCount: 3 }),
      { contentCount: 3 }
    )).toBe(false)
  })
})
