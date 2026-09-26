import { describe, expect, test } from 'vitest'
import type { Content } from '@/types'
import { applyStreamChunkToContents } from '@/stores/agentRun/contentDelta'
import { appendMonitorFloorIndices, computeMonitorMessageFloorMap, renderMonitorMessages, type MonitorRenderCacheEntry } from '../monitorMessages'
import { prependRunContentWindow, replaceRunContentWindow, replaceRunContentWindowPreservingPrefix, type SubAgentRunContentWindowState } from '../monitorWindowState'

const invocation: Content = { role: 'user', parts: [{ text: '# SubAgent Invocation\n\n## Agent System Prompt\nsystem configuration' }], index: 0 }
const response = (index: number): Content => ({ role: 'user', index, parts: [{ functionResponse: { id: 'tool', name: 'read_file', response: { success: true } } }] })
const content = (index: number, role: Content['role'] = 'model'): Content => ({ role, index, parts: [{ text: `message ${index}` }] })
const all = [invocation, content(1, 'user'), content(2), response(3), content(4, 'user'), response(5), content(6), content(7)]
function window(startIndex = 4, endIndex = 8): SubAgentRunContentWindowState {
  return { runId: 'a', startIndex, endIndex, totalCount: 8, contentRevision: 1, eventSequence: 1,
    floorIndices: [1, 2, 4, 6, 7], contents: all.slice(startIndex, endIndex), hasMoreBefore: startIndex > 0, hasMoreAfter: endIndex < 8 }
}

const floors = (value: SubAgentRunContentWindowState) => [...computeMonitorMessageFloorMap(value)]

describe('Monitor 全局楼层和流式投影', () => {
  test('首次尾窗与前置历史楼层相同，Invocation/工具响应不占楼，前置不丢失尾部资格', () => {
    const tail = window()
    expect(floors(tail)).toEqual([['a_4', 3], ['a_6', 4], ['a_7', 5]])
    const merged = prependRunContentWindow(tail, window(0, 4))!
    expect(floors(merged)).toEqual([['a_1', 1], ['a_2', 2], ['a_4', 3], ['a_6', 4], ['a_7', 5]])
    expect(merged.hasMoreAfter).toBe(false)
    expect(merged.contents[4]).toBe(tail.contents[0])
  })

  test('旧宿主缺索引时尾页不猜号，从真实起点加载才编号且排除Invocation', () => {
    const tail = { ...window(), floorIndices: undefined }
    expect(floors(tail)).toEqual([])
    expect(floors({ ...window(0), floorIndices: undefined })).toEqual([['a_1', 1], ['a_2', 2], ['a_4', 3], ['a_6', 4], ['a_7', 5]])
  })

  test('工具响应后的实时新回复顺延，旧分页晚到不会让实时楼层回退', () => {
    const tail = { ...window(4, 6), totalCount: 6, hasMoreAfter: false, floorIndices: [1, 2, 4] }
    const contents = applyStreamChunkToContents(tail.contents, { delta: [{ text: 'stream' }] }, 1000, 4)
    const live = { ...tail, contents, floorIndices: appendMonitorFloorIndices(tail, contents), endIndex: 7, totalCount: 7 }
    expect(floors(live)).toEqual([['a_4', 3], ['a_6', 4]])
    const older = { ...window(0, 4), totalCount: 6, floorIndices: [1, 2, 4] }
    const merged = prependRunContentWindow(live, older)!
    expect(merged.totalCount).toBe(7)
    expect(merged.floorIndices).toEqual([1, 2, 4, 6])
    expect(computeMonitorMessageFloorMap(merged).get('a_6')).toBe(4)
    expect(merged.hasMoreAfter).toBe(false)
  })

  test('删除/重试校准替换楼层快照，跨修订迟到分页不混合索引', () => {
    const current = window(0)
    const changed = { ...window(1, 4), contents: [content(1, 'user'), content(2), content(3)], floorIndices: [1, 2, 3], totalCount: 4, contentRevision: 2, hasMoreAfter: false }
    const replaced = replaceRunContentWindow(changed, current)!
    expect(floors(replaced)).toEqual([['a_1', 1], ['a_2', 2], ['a_3', 3]])
    expect(prependRunContentWindow(replaced, window(0, 1))).toBe(replaced)
    expect(replaceRunContentWindowPreservingPrefix(changed, current)).toBe(changed)
  })

  test('完成/暂停/排队/等待处理/历史不显示loading；只有活跃运行的真实尾部model流式', () => {
    const value = window(0)
    const cache = new Map<number, MonitorRenderCacheEntry>()
    const run = { runId: 'a', contents: value.contents, status: 'running' as const, streamingContentIndex: 7 }
    const running = renderMonitorMessages(run, value, undefined, true, cache)
    expect(running.filter(message => message.streaming).map(message => message.backendIndex)).toEqual([7])
    expect(running.map(message => message.backendIndex)).toEqual([0, 1, 2, 4, 6, 7])
    for (const status of ['completed', 'paused', 'queued', 'awaiting_monitor_action', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(renderMonitorMessages({ ...run, status }, value, undefined, true, cache).some(message => message.streaming)).toBe(false)
    }
    expect(renderMonitorMessages(run, value, undefined, false, cache).some(message => message.streaming)).toBe(false)
    expect(renderMonitorMessages(run, { ...value, hasMoreAfter: true }, undefined, true, cache).some(message => message.streaming)).toBe(false)
    expect(renderMonitorMessages({ ...run, streamingContentIndex: null }, value, undefined, true, cache).some(message => message.streaming)).toBe(false)
    expect(renderMonitorMessages({ ...run, streamingContentIndex: undefined }, value, undefined, true, cache).some(message => message.streaming)).toBe(false)
    const resumed = renderMonitorMessages(run, value, undefined, true, cache)
    expect(resumed.at(-1)?.streaming).toBe(true)
    expect(resumed[1]).toBe(running[1])
  })

  test('真实模型请求在首delta前创建同楼层占位，首delta后沿用身份且不双占楼', () => {
    const value = { ...window(4, 6), totalCount: 6, hasMoreAfter: false, floorIndices: [1, 2, 4] }
    const run = { runId: 'a', contents: value.contents, status: 'running' as const, streamingContentIndex: 6 }
    const cache = new Map<number, MonitorRenderCacheEntry>()
    const pending = renderMonitorMessages(run, value, undefined, true, cache)
    expect(pending.at(-1)).toMatchObject({ id: 'a_6', role: 'assistant', streaming: true, content: '' })
    expect(pending.at(-1)?.backendIndex).toBeUndefined()
    expect(computeMonitorMessageFloorMap(value, 6).get('a_6')).toBe(4)
    const contents = applyStreamChunkToContents(value.contents, { delta: [{ text: 'first delta' }] }, 1000, 4)
    const live = { ...value, contents, floorIndices: appendMonitorFloorIndices(value, contents), totalCount: 7, endIndex: 7 }
    const streamed = renderMonitorMessages({ ...run, contents }, live, undefined, true, cache)
    expect(streamed.filter(message => message.id === 'a_6')).toHaveLength(1)
    expect(streamed.at(-1)?.backendIndex).toBe(6)
    expect(computeMonitorMessageFloorMap(live, 6).get('a_6')).toBe(4)
  })

  test('保留正文引用的工具回复到达后仍刷新最终结果', () => {
    const call: Content = { role: 'model', index: 1, parts: [{ functionCall: { id: 'tool', name: 'read_file', args: {} } }] }
    const cache = new Map<number, MonitorRenderCacheEntry>()
    const run = { runId: 'a', status: 'running' as const, contents: [call] }
    const before = renderMonitorMessages(run, undefined, undefined, true, cache)
    const after = renderMonitorMessages({ ...run, contents: [call, response(2)] }, undefined, undefined, true, cache)
    expect(after[0]).not.toBe(before[0])
    expect(after[0].tools?.[0].status).toBe('success')
    expect(after[0].tools?.[0].result).toEqual({ success: true })
  })
})
