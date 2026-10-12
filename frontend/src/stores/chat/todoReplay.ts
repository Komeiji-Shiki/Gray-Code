import { computed as vueComputed, toRaw } from 'vue'
import type { Message } from '../../types'
import { replayTodoStateFromMessages, type ReplayTodoState } from '../../utils/todoList'
import { getMessagesStructuralVersion, getToolResponseCacheRevision } from './state'
import type { ChatStoreState } from './types'

/** 重放指纹仅绑定当前消息窗口与响应索引，流式尾部更新可以增量复用。 */
export function createTodoReplay(state: ChatStoreState, resolveToolResponse: (toolCallId: string) => Record<string, unknown> | undefined) {
  interface TodoReplayFingerprint {
    messages: Message[]
    structure: number
    responses: Map<string, Record<string, unknown>>
    responseRevision: number
    responseCount: number
  }
  const todoReplayFingerprint = (): TodoReplayFingerprint => ({
    messages: toRaw(state.allMessages.value),
    structure: getMessagesStructuralVersion(state),
    responses: toRaw(state.toolResponseCache.value),
    responseRevision: getToolResponseCacheRevision(state),
    responseCount: state.toolResponseIndex.value.size,
  })
  const sameTodoReplayInput = (left: TodoReplayFingerprint, right: TodoReplayFingerprint) =>
    left.messages === right.messages &&
    left.structure === right.structure &&
    left.responses === right.responses &&
    left.responseRevision === right.responseRevision &&
    left.responseCount === right.responseCount
  const resolveTodoToolResponse = (toolCallId: string) => resolveToolResponse(toolCallId)

  /**
   * todoSnapshot 增量重放缓存：缓存 [0, scannedCount) 的重放中间态。输入指纹不变时只从上次位置
   * 重放尾部（含旧尾消息——流式期间其 tools 会被原地追加/改写），其余变化回退全量重放。
   * 流式增量每批只处理尾消息，不再复制整份响应缓存或扫描全部 functionResponse。
   */
  let todoReplayCache: {
    scannedCount: number
    input: TodoReplayFingerprint
    result: ReplayTodoState
  } | null = null

  const todoSnapshot = vueComputed(() => {
    const allMessages = state.allMessages.value
    const len = allMessages.length
    const prefixCount = Math.max(0, len - 1)
    const input = todoReplayFingerprint()
    const cache = todoReplayCache
    const incremental = cache !== null && cache.scannedCount <= prefixCount && sameTodoReplayInput(cache.input, input)

    const prefix =
      incremental && cache.scannedCount === prefixCount
        ? cache.result
        : replayTodoStateFromMessages(allMessages, {
            resolveToolResponseById: resolveTodoToolResponse,
            fromIndex: incremental ? cache.scannedCount : 0,
            beforeIndex: prefixCount,
            initialTodos: incremental ? cache.result.todos : null,
            initialAnchorBackendIndex: incremental ? cache.result.anchorBackendIndex : null,
            initialTouched: incremental && cache.result.todos !== null,
          })

    // 缓存结果必须与扫描边界一致；尾工具消失时从固定前缀重新计算，不能沿用旧尾的待办。
    todoReplayCache = {
      scannedCount: prefixCount,
      input,
      result: prefix,
    }
    return replayTodoStateFromMessages(allMessages, {
      resolveToolResponseById: resolveTodoToolResponse,
      fromIndex: prefixCount,
      initialTodos: prefix.todos,
      initialAnchorBackendIndex: prefix.anchorBackendIndex,
      initialTouched: prefix.todos !== null,
    })
  })

  /**
   * 单张 TODO 工具卡片的重放：只重放到卡片自身位置，之后的流式增量不影响其结果。
   * 按停止位置缓存，输入指纹不变、重放读到的消息尚未被尾部更新覆盖时直接复用，
   * 全局流式期间每张历史卡片不再逐批重新遍历历史。
   */
  const todoStateAtTool = new Map<string, { input: TodoReplayFingerprint; length: number; result: ReplayTodoState }>()
  const replayTodoStateUntil = (stop: { toolId?: string; backendIndex?: number }): ReplayTodoState => {
    const messages = state.allMessages.value
    const input = todoReplayFingerprint()
    const key = `${stop.toolId ?? ''}\n${stop.backendIndex ?? ''}`
    const cached = todoStateAtTool.get(key)
    // 消息对象写入窗口后只有尾消息会被原地替换；重放在旧尾之前停止时，尾部更新与追加都不影响结果。
    if (cached && sameTodoReplayInput(cached.input, input) && cached.result.lastReadIndex < cached.length - 1 && messages.length >= cached.length) {
      // 仍读取重放范围内的消息位置，让调用方的 computed 在这些位置被替换时重新求值。
      for (let index = 0; index <= cached.result.lastReadIndex; index++) void messages[index]
      return cached.result
    }
    const result = replayTodoStateFromMessages(messages, {
      resolveToolResponseById: resolveTodoToolResponse,
      stopAtToolId: stop.toolId,
      stopAtBackendIndex: stop.backendIndex,
    })
    if (todoStateAtTool.size >= 256) todoStateAtTool.clear()
    todoStateAtTool.set(key, { input, length: messages.length, result })
    return result
  }

  return { todoSnapshot, replayTodoStateUntil }
}
