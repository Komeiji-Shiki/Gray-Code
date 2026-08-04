/**
 * windowUtils 可见消息增量缓存测试（HIS-12 前端部分）。
 *
 * 覆盖：
 * - 首次读取全量过滤；
 * - 尾部追加只增量处理（可见/不可见消息分别验证）；
 * - 同长度尾部替换原地更新缓存尾元素；
 * - 移除/换新数组回退全量重建；
 * - 缓存结果与 filterVisibleChatMessages 一致。
 */
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { Message } from '../../../types'
import type { ChatStoreState } from '../types'
import { getVisibleChatMessagesCached, clearVisibleChatMessagesCache } from '../windowUtils'
import { filterVisibleChatMessages } from '../visibilityUtils'
import { replaceMessageAt } from '../state'

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: Date.now(),
    ...overrides
  } as Message
}

function makeState(messages: Message[] = []): ChatStoreState {
  return {
    allMessages: ref(messages)
  } as unknown as ChatStoreState
}

describe('getVisibleChatMessagesCached（HIS-12）', () => {
  it('首次读取等于全量过滤结果', () => {
    const state = makeState([
      makeMessage('m1'),
      makeMessage('fr1', { isFunctionResponse: true }),
      makeMessage('m2')
    ])
    const visible = getVisibleChatMessagesCached(state)
    expect(visible).toEqual(filterVisibleChatMessages(state.allMessages.value))
    expect(visible.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('尾部追加可见消息：增量加入缓存', () => {
    const state = makeState([makeMessage('m1')])
    const first = getVisibleChatMessagesCached(state)

    state.allMessages.value.push(makeMessage('m2'))
    const second = getVisibleChatMessagesCached(state)
    expect(second).toHaveLength(2)
    expect(second[1].id).toBe('m2')
    expect(second[0]).toBe(first[0])
  })

  it('尾部追加 functionResponse（不可见）：可见列表不变且不新增元素', () => {
    const state = makeState([makeMessage('m1')])
    const first = getVisibleChatMessagesCached(state)

    state.allMessages.value.push(makeMessage('fr1', { isFunctionResponse: true }))
    const second = getVisibleChatMessagesCached(state)
    expect(second).toHaveLength(1)
    expect(second[0]).toBe(first[0])
  })

  it('同长度尾部替换：缓存尾元素指向新对象（流式原地更新）', () => {
    const state = makeState([makeMessage('m1'), makeMessage('m2', { content: 'old' })])
    const first = getVisibleChatMessagesCached(state)

    const newTail = makeMessage('m2', { content: 'new content' })
    state.allMessages.value[1] = newTail
    const second = getVisibleChatMessagesCached(state)

    expect(second).toHaveLength(2)
    // Vue ref 会返回响应式代理：用内容与 id 验证“尾元素已指向新对象”
    expect(second[1].id).toBe('m2')
    expect(second[1].content).toBe('new content')
    // 首元素引用不变
    expect(second[0]).toBe(first[0])
  })

  it('同长度尾部替换为 functionResponse：回退全量重建', () => {
    const state = makeState([makeMessage('m1'), makeMessage('m2')])
    getVisibleChatMessagesCached(state)

    state.allMessages.value[1] = makeMessage('m2', { isFunctionResponse: true })
    const second = getVisibleChatMessagesCached(state)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe('m1')
  })

  it('移除消息（长度变小）：回退全量重建', () => {
    const state = makeState([makeMessage('m1'), makeMessage('fr1', { isFunctionResponse: true }), makeMessage('m2')])
    const first = getVisibleChatMessagesCached(state)
    expect(first).toHaveLength(2)

    state.allMessages.value.splice(0, 1) // 移除 m1
    const second = getVisibleChatMessagesCached(state)
    expect(second.map(m => m.id)).toEqual(['m2'])
  })

  it('整体替换数组（新引用）：全量重建', () => {
    const state = makeState([makeMessage('m1')])
    getVisibleChatMessagesCached(state)

    state.allMessages.value = [makeMessage('a'), makeMessage('fr', { isFunctionResponse: true }), makeMessage('b')]
    const visible = getVisibleChatMessagesCached(state)
    expect(visible.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('clearVisibleChatMessagesCache 后全量重建', () => {
    const state = makeState([makeMessage('m1')])
    getVisibleChatMessagesCached(state)
    clearVisibleChatMessagesCache(state)

    state.allMessages.value.push(makeMessage('m2'))
    const visible = getVisibleChatMessagesCached(state)
    expect(visible.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('中间位置同长度替换（replaceMessageAt index !== length-1）：清除缓存后全量重建（L1）', () => {
    // 场景：迟到的旧请求 cancelled chunk 清理中间消息元数据（同 id 同长度，首尾引用不变）
    const state = makeState([makeMessage('m1'), makeMessage('m2'), makeMessage('m3')])
    const first = getVisibleChatMessagesCached(state)
    expect(first.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])

    replaceMessageAt(state, 0, makeMessage('m1', { content: 'm1-edited' }))

    // 若不清除缓存：指纹（首尾元素）不变 → 命中陈旧缓存，m1-edited 不可见
    const second = getVisibleChatMessagesCached(state)
    expect(second).toHaveLength(3)
    expect(second[0].content).toBe('m1-edited')
  })

  it('尾元素同长度替换（index === length-1）：仍走增量原地更新，不清缓存', () => {
    const state = makeState([makeMessage('m1'), makeMessage('m2')])
    const first = getVisibleChatMessagesCached(state)

    const newTail = makeMessage('m2', { content: 'tail-edited' })
    replaceMessageAt(state, 1, newTail)

    const second = getVisibleChatMessagesCached(state)
    expect(second).toHaveLength(2)
    expect(second[1].content).toBe('tail-edited')
    expect(second[0]).toBe(first[0])
  })
})
