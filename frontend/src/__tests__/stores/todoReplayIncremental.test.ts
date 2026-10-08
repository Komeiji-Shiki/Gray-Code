/**
 * TODO 重放增量缓存回归测试。
 *
 * 背景：长会话里每批流式增量都会替换尾消息。todoSnapshot 此前每批复制整份工具响应缓存并扫描
 * 全部 functionResponse；每张 todo_write 卡片也都从头重放到自身位置，窗口内卡片越多越卡。
 *
 * 期望：尾消息替换和追加时，历史卡片直接复用结果，todoSnapshot 只重放尾部；
 * 位于尾消息上的卡片和结构变化仍然重新计算，结果与全量重放一致。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, effectScope, reactive } from 'vue'
import type { Message } from '../../types'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async () => ({ success: true })),
  onMessageFromExtension: vi.fn(() => () => {}),
  onExtensionCommand: vi.fn(() => () => {})
}))

vi.mock('../../utils/todoList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/todoList')>()
  return { ...actual, replayTodoStateFromMessages: vi.fn(actual.replayTodoStateFromMessages) }
})

import { replayTodoStateFromMessages } from '../../utils/todoList'
import { useChatStore } from '../../stores/chatStore'
import { createChatState, replaceMessageAt, removeMessageAt } from '../../stores/chat/state'
import { createChatComputed } from '../../stores/chat/computed'
import { useBuildPanel, type UseBuildPanelOptions } from '../../components/message/useBuildPanel'

const replay = vi.mocked(replayTodoStateFromMessages)

function user(index: number): Message {
  return { id: `user_${index}`, role: 'user', content: `u${index}`, timestamp: index, backendIndex: index, parts: [{ text: `u${index}` }] } as Message
}

function todoWrite(index: number, toolId: string, contents: string[]): Message {
  return {
    id: `assistant_${index}`, role: 'assistant', content: '', timestamp: index, backendIndex: index,
    parts: [{ functionCall: { id: toolId, name: 'todo_write', args: {} } }],
    tools: [{ id: toolId, name: 'todo_write', status: 'success',
      args: { todos: contents.map((content, i) => ({ id: String(i + 1), content, status: 'pending' })) } }]
  } as Message
}

function response(index: number, toolId: string): Message {
  return {
    id: `fr_${index}`, role: 'user', content: '', timestamp: index, backendIndex: index, isFunctionResponse: true,
    parts: [{ functionResponse: { id: toolId, name: 'todo_write', response: { success: true } } }]
  } as Message
}

function streaming(index: number, text: string): Message {
  return { id: `assistant_${index}`, role: 'assistant', content: text, timestamp: index, backendIndex: index, streaming: true, parts: [{ text }] } as Message
}

describe('TODO 重放增量缓存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    replay.mockClear()
  })

  test('历史卡片在尾消息流式替换与追加时复用结果，尾部卡片仍重新计算', () => {
    const store = useChatStore()
    store.allMessages = [user(0), todoWrite(1, 'todo-1', ['a', 'b']), response(2, 'todo-1'), user(3), streaming(4, 'x')]
    const stop = { toolId: 'todo-1', backendIndex: 1 }

    // 首次读取会经回退扫描重建工具响应索引，第二次读取后指纹稳定
    store.replayTodoStateUntil(stop)
    const settled = store.replayTodoStateUntil(stop)
    expect(settled.todos?.map(todo => todo.content)).toEqual(['a', 'b'])
    replay.mockClear()

    store.allMessages[4] = streaming(4, 'xy')
    expect(store.replayTodoStateUntil(stop)).toBe(settled)
    store.allMessages.push(user(5))
    expect(store.replayTodoStateUntil(stop)).toBe(settled)
    expect(replay).not.toHaveBeenCalled()

    // 停止位置在尾消息上的卡片随流式内容变化重新计算
    store.allMessages.push(todoWrite(6, 'todo-2', ['c']))
    const tail = { toolId: 'todo-2', backendIndex: 6 }
    expect(store.replayTodoStateUntil(tail).todos?.map(todo => todo.content)).toEqual(['c'])
    store.allMessages[6] = todoWrite(6, 'todo-2', ['c', 'd'])
    expect(store.replayTodoStateUntil(tail).todos?.map(todo => todo.content)).toEqual(['c', 'd'])
    expect(replay).toHaveBeenCalledTimes(2)

    // 整体替换窗口后不复用旧结果
    store.allMessages = [user(0), todoWrite(1, 'todo-1', ['changed']), response(2, 'todo-1')]
    expect(store.replayTodoStateUntil(stop).todos?.map(todo => todo.content)).toEqual(['changed'])
  })

  test('todoSnapshot 在尾消息流式替换时只重放尾部，结果与全量一致', () => {
    const store = useChatStore()
    store.allMessages = [user(0), todoWrite(1, 'todo-1', ['a']), response(2, 'todo-1'), streaming(3, 'x')]
    void store.todoSnapshot
    void store.todoSnapshot
    replay.mockClear()

    store.allMessages[3] = todoWrite(3, 'todo-2', ['b', 'c'])
    expect(store.todoSnapshot.todos?.map(todo => todo.content)).toEqual(['b', 'c'])
    expect(replay).toHaveBeenCalledTimes(1)
    expect(replay.mock.calls[0][1]).toMatchObject({ fromIndex: 3 })

    store.allMessages[3] = streaming(3, '工具已取消')
    expect(store.todoSnapshot.todos?.map(todo => todo.content)).toEqual(['a'])
  })

  test('计划同步不缓存尾工具结果，中间替换与删除按结构版本重新计算', () => {
    const state = createChatState()
    const plan = (index: number, content: string): Message => ({ ...streaming(index, ''), tools: [{ id: `plan-${index}`,
      name: 'update_plan', status: 'success', args: { path: 'plan.md', updateMode: 'progress_sync' },
      result: { success: true, data: { path: 'plan.md', updateMode: 'progress_sync', content } } }] } as Message)
    state.allMessages.value = [user(0), plan(1, '固定前缀'), user(2), plan(3, '可变尾部')]
    state.activeBuild.value = { id: 'build', status: 'running', title: '计划', planPath: 'plan.md', startedAt: 0, anchorBackendIndex: 0 } as any
    state.isWaitingForResponse.value = true
    const store = reactive({ ...state, ...createChatComputed(state), todoSnapshot: { todos: null }, toolResponseCacheRevision: 0,
      setActiveBuild: vi.fn(async () => {}) }) as unknown as UseBuildPanelOptions['chatStore']
    const scope = effectScope()
    try {
      const panel = scope.run(() => useBuildPanel({ chatStore: store, getMergedToolResult: tool => tool.result ?? {},
        allMessageIndexBounds: computed(() => ({ firstIndexed: 0, lastIndexed: 3, nextFallbackIndex: 4 })) }))!
      expect(panel.activeBuildPlanSync.value?.content).toBe('可变尾部')
      replaceMessageAt(state, 3, streaming(3, '工具已取消'))
      expect(panel.activeBuildPlanSync.value?.content).toBe('固定前缀')
      replaceMessageAt(state, 1, plan(1, '修改后的前缀'))
      expect(panel.activeBuildPlanSync.value?.content).toBe('修改后的前缀')
      removeMessageAt(state, 1)
      expect(panel.activeBuildPlanSync.value).toBeNull()
    } finally { scope.stop() }
  })
})
