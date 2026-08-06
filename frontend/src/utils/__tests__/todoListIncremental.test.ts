/**
 * M-1 回归测试：replayTodoStateFromMessages 增量重放参数（fromIndex/initial*）。
 *
 * 背景：chatStore.todoSnapshot 使用「前缀引用 + 响应表校验」的增量重放缓存——前缀不变时
 * 仅重放尾部新增消息（initialTodos/initialAnchorBackendIndex/initialTouched 提供此前状态）。
 * 该增量参数此前无任何直接测试，增量分支正确性依赖「增量结果与全量重放严格一致」的隐式
 * 不变量。
 *
 * 覆盖：分段重放一致性、流式追加一致性、fromIndex 边界、todo_update 在 initial 列表上
 * 正确应用、initialTouched=false 语义。
 */

import { describe, it, expect } from 'vitest'
import { replayTodoStateFromMessages } from '../todoList'
import type { TodoItem } from '../todoList'
import type { Message } from '../../types'

function tool(id: string, name: string, args: Record<string, unknown>, result?: Record<string, unknown>) {
  return { id, name, args, ...(result ? { result } : {}) } as any
}

/** create_plan/update_plan 需要 continuationPrompt 才会被当作有效 todo 工具处理 */
function planTool(id: string, name: 'create_plan' | 'update_plan', todos: Record<string, unknown>[]): any {
  return tool(id, name, { todos }, { continuationPrompt: 'implement', todos })
}

function assistantMsg(backendIndex: number, tools: any[]): Message {
  return { role: 'assistant', backendIndex, tools } as any
}

const PLAN_TODOS: TodoItem[] = [
  { id: 'a', content: 'A', status: 'pending' },
  { id: 'b', content: 'B', status: 'pending' }
]

describe('M-1: replayTodoStateFromMessages 增量重放', () => {
  it('分段重放：全量结果 == 前缀状态 + 增量重放尾部', () => {
    const messages = [
      assistantMsg(0, [planTool('t1', 'create_plan', PLAN_TODOS)]),
      assistantMsg(1, [
        planTool('t2', 'update_plan', [
          { id: 'a', content: 'A', status: 'completed' },
          { id: 'b', content: 'B', status: 'in_progress' }
        ])
      ]),
      assistantMsg(2, [tool('t3', 'todo_update', { ops: [{ op: 'set_status', id: 'b', status: 'completed' }] })])
    ]

    const full = replayTodoStateFromMessages(messages)
    const mid = replayTodoStateFromMessages(messages.slice(0, 2))

    const incremental = replayTodoStateFromMessages(messages, {
      fromIndex: 2,
      initialTodos: mid.todos,
      initialAnchorBackendIndex: mid.anchorBackendIndex,
      initialTouched: mid.todos !== null
    })

    expect(incremental.todos).toEqual(full.todos)
    expect(incremental.anchorBackendIndex).toBe(full.anchorBackendIndex)
    expect(full.todos).toEqual([
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'b', content: 'B', status: 'completed' }
    ])
  })

  it('流式追加场景：缓存前缀状态 + 增量重放尾部 == 全量重放', () => {
    const base = [assistantMsg(0, [planTool('t1', 'create_plan', PLAN_TODOS)])]
    const first = replayTodoStateFromMessages(base)

    const extended = [
      ...base,
      assistantMsg(1, [
        planTool('t2', 'update_plan', [
          { id: 'a', content: 'A', status: 'completed' },
          { id: 'b', content: 'B', status: 'pending' }
        ])
      ])
    ]

    const incremental = replayTodoStateFromMessages(extended, {
      fromIndex: 1,
      initialTodos: first.todos,
      initialAnchorBackendIndex: first.anchorBackendIndex,
      initialTouched: first.todos !== null
    })
    const full = replayTodoStateFromMessages(extended)

    expect(incremental.todos).toEqual(full.todos)
    expect(incremental.anchorBackendIndex).toBe(full.anchorBackendIndex)
    // 锚点来自第一条有效工具调用消息（backendIndex 0 → anchor 1），增量不得改变
    expect(incremental.anchorBackendIndex).toBe(1)
  })

  it('fromIndex 超过消息长度：直接返回 initial 状态（不新增 todo 时保持原样）', () => {
    const messages = [assistantMsg(0, [planTool('t1', 'create_plan', PLAN_TODOS)])]
    const full = replayTodoStateFromMessages(messages)

    const incremental = replayTodoStateFromMessages(messages, {
      fromIndex: 99,
      initialTodos: full.todos,
      initialAnchorBackendIndex: full.anchorBackendIndex,
      initialTouched: true
    })

    expect(incremental.todos).toEqual(full.todos)
    expect(incremental.anchorBackendIndex).toBe(full.anchorBackendIndex)
  })

  it('todo_update 增量操作正确应用在 initial 列表上（含 add 与 update）', () => {
    const initialTodos: TodoItem[] = [
      { id: 'a', content: 'A', status: 'pending' },
      { id: 'b', content: 'B', status: 'pending' }
    ]
    const messages = [
      assistantMsg(1, [
        tool('t3', 'todo_update', {
          ops: [
            { op: 'set_status', id: 'b', status: 'completed' },
            { op: 'add', id: 'c', content: 'C', status: 'pending' }
          ]
        })
      ])
    ]

    const result = replayTodoStateFromMessages(messages, {
      fromIndex: 0,
      initialTodos,
      initialAnchorBackendIndex: 0,
      initialTouched: true
    })

    expect(result.todos).toEqual([
      { id: 'a', content: 'A', status: 'pending' },
      { id: 'b', content: 'B', status: 'completed' },
      { id: 'c', content: 'C', status: 'pending' }
    ])
  })

  it('initialTouched=false 且尾部无 todo 工具调用：todos 保持 null', () => {
    const messages = [assistantMsg(0, [tool('t9', 'read_file', { path: 'x.txt' })])]
    const result = replayTodoStateFromMessages(messages, {
      fromIndex: 0,
      initialTodos: null,
      initialAnchorBackendIndex: null,
      initialTouched: false
    })
    expect(result.todos).toBeNull()
    expect(result.anchorBackendIndex).toBeNull()
  })

  it('initialTouched=true 且尾部无 todo 工具：保留 initial 列表', () => {
    const messages = [assistantMsg(0, [tool('t9', 'read_file', { path: 'x.txt' })])]
    const result = replayTodoStateFromMessages(messages, {
      fromIndex: 0,
      initialTodos: PLAN_TODOS,
      initialAnchorBackendIndex: 1,
      initialTouched: true
    })
    expect(result.todos).toEqual(PLAN_TODOS)
    expect(result.anchorBackendIndex).toBe(1)
  })
})
