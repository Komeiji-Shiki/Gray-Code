/**
 * 流式处理辅助函数
 * 
 * @module streamHelpers
 * 包含消息操作、工具调用解析等辅助函数
 */

import type { Message } from '../../types'
import type { ChatStoreState } from './types'
import { generateId } from '../../utils/format'
import { isPerfEnabled } from '../../utils/perf'


const todoDebugPrinted = new Set<string>()
function debugTodoOnce(key: string, data: Record<string, unknown>) {
  if (!isPerfEnabled()) return
  if (todoDebugPrinted.has(key)) return
  todoDebugPrinted.add(key)
  console.debug('[todo-debug][streamHelpers]', data)
}

function isTodoToolName(name: unknown): boolean {
  return name === 'todo_write' || name === 'todo_update' || name === 'create_plan'
}

/**
 * 添加 functionCall 到消息
 */
export function addFunctionCallToMessage(
  message: Message,
  call: { 
    id: string; 
    name: string; 
    args: Record<string, unknown>; 
    partialArgs?: string; 
    index?: number 
  }
): void {
  // 更新 tools 数组
  if (!message.tools) {
    message.tools = []
  }
  message.tools.push({
    id: call.id,
    name: call.name,
    args: call.args,
    // 传递 partialArgs 以便 ToolMessage 组件显示流式预览
    partialArgs: call.partialArgs,
    // 刚从流式内容里解析/拼接出来的工具调用，视为“AI 还在输出/完善工具内容”
    // 有 partialArgs 说明参数仍在流式累积中；无 partialArgs 说明已拿到完整参数
    status: typeof call.partialArgs === 'string' ? 'streaming' : 'queued'
  })
  
  // 更新 parts（用于渲染）
  if (!message.parts) {
    message.parts = []
  }
  message.parts.push({
    functionCall: {
      id: call.id,
      name: call.name,
      args: call.args,
      partialArgs: call.partialArgs,
      index: call.index
    }
  })
}

/**
 * 添加文本到消息（合并连续的文本 part）
 */
export function addTextToMessage(message: Message, text: string, isThought: boolean = false): void {
  // 普通文本才累加到 content
  if (!isThought) {
    message.content += text
  }
  
  if (!message.parts) {
    message.parts = []
  }
  
  const lastPart = message.parts[message.parts.length - 1]
  // 只有相同类型（都是思考或都不是思考）才合并
  const lastIsThought = lastPart?.thought === true
  if (lastPart && lastPart.text !== undefined && !lastPart.functionCall && lastIsThought === isThought) {
    lastPart.text += text
  } else {
    message.parts.push(isThought ? { text, thought: true } : { text })
  }
}

/**
 * 处理流式文本
 *
 * Prompt 模式工具调用现在以后端解析结果为准。
 * 前端这里只负责把可见文本追加到消息中。
 */
export function processStreamingText(
  message: Message,
  text: string,
  _state: ChatStoreState
): void {
  addTextToMessage(message, text)
}

/**
 * 兼容旧调用链。
 * Prompt 模式工具缓冲现在位于后端，此处不再需要额外处理。
 */
export function flushToolCallBuffer(_message: Message, _state: ChatStoreState): void {
}

/**
 * 处理工具调用 part（原生 function call format）
 */

/**
 * partialArgs JSON.parse 节流控制
 * 
 * 问题：每个增量片段都对整个累积字符串做 JSON.parse，当参数很大时（如 write_file 写长代码），
 * 复杂度退化为 O(N²)，导致主线程卡死。
 * 
 * 策略：
 * - 跟踪上次成功/尝试 parse 时的字符串长度
 * - 每次增量后，只有当新增数据量超过阈值时才再次尝试 parse
 * - 阈值随字符串长度动态增长：短字符串频繁 parse（保证小参数的预览体验），
 *   长字符串大幅减少 parse 次数（避免 O(N²) 卡顿）
 */
const partialArgsParseState = new WeakMap<object, { lastParseLen: number }>()

function shouldAttemptParse(fcRef: object, currentLen: number): boolean {
  let state = partialArgsParseState.get(fcRef)
  if (!state) {
    state = { lastParseLen: 0 }
    partialArgsParseState.set(fcRef, state)
  }
  // 动态阈值：短字符串(<1KB) 每 200 字符 parse 一次；
  // 中等字符串(1-10KB) 每 1KB parse 一次；长字符串 每 4KB parse 一次
  const threshold = currentLen < 1024 ? 200 : currentLen < 10240 ? 1024 : 4096
  const delta = currentLen - state.lastParseLen
  if (delta < threshold) return false
  state.lastParseLen = currentLen
  return true
}

export function handleFunctionCallPart(part: any, message: Message): void {
  const fc = part.functionCall
  const lastPart = message.parts![message.parts!.length - 1]

  const incomingId = typeof fc.id === 'string' && fc.id.trim() ? fc.id.trim() : ''
  const incomingHasPartial = typeof fc.partialArgs === 'string'
  const incomingHasArgs = !!(fc.args && Object.keys(fc.args).length > 0)
  
  // 尝试合并到最后一个工具调用块
  let merged = false
  if (lastPart && lastPart.functionCall) {
    const lastFc = lastPart.functionCall
    const lastId = typeof lastFc.id === 'string' && lastFc.id.trim() ? lastFc.id.trim() : ''
    const lastHasPartial = typeof lastFc.partialArgs === 'string'
    
    // 只在“明显仍是同一次工具调用增量”时合并，避免把后续独立工具调用误并到上一条。
    const sameId = incomingId && lastId && incomingId === lastId
    const sameIndex = fc.index !== undefined && lastFc.index === fc.index

    const canMergeByIndex =
      !sameId &&
      sameIndex &&
      lastHasPartial &&
      (incomingHasPartial || incomingHasArgs)

    const canMergeLegacyPartial =
      !sameId &&
      !incomingId &&
      fc.index === undefined &&
      incomingHasPartial

    // OpenAI Responses API 模式：初始 chunk { name, id, index: null } 后跟
    // 数据 chunk { index: N, partialArgs }。初始 chunk 无 partialArgs 也无 args，
    // 需要特殊处理把首个数据 chunk 合并到刚创建的工具上。
    const lastIsFreshTool = !lastHasPartial && (!lastFc.args || Object.keys(lastFc.args).length === 0)
    const canMergeAsFreshToolData =
      !sameId &&
      !incomingId &&
      incomingHasPartial &&
      lastIsFreshTool

    const canMerge = !!(sameId || canMergeByIndex || canMergeLegacyPartial || canMergeAsFreshToolData)
    
    if (canMerge) {
      if (isTodoToolName(fc.name) || isTodoToolName(lastFc.name)) {
        debugTodoOnce(`merge-${message.id}-${lastFc.id || 'no-last-id'}-${fc.id || 'no-id'}-${String(fc.name || lastFc.name)}`, {
          messageId: message.id,
          action: 'merge_function_call_part',
          incomingName: fc.name || null,
          incomingId: incomingId || null,
          incomingIndex: fc.index ?? null,
          incomingHasPartial,
          incomingHasArgs,
          lastName: lastFc.name || null,
          lastId: lastId || null,
          lastIndex: lastFc.index ?? null,
          canMerge,
          canMergeReason: sameId ? 'sameId' : (canMergeByIndex ? 'sameIndexWithPartial' : (canMergeLegacyPartial ? 'legacyPartial' : 'none'))
        })
      }

      // 合并名称、ID 和 index
      if (fc.name && !lastFc.name) lastFc.name = fc.name
      if (fc.id && !lastFc.id) lastFc.id = fc.id
      if (typeof fc.index === 'number' && (lastFc.index === undefined || lastFc.index === null)) {
        lastFc.index = fc.index
      }
      
      // 合并参数
      if (incomingHasPartial) {
        lastFc.partialArgs = (lastFc.partialArgs || '') + fc.partialArgs
        // 节流式 JSON.parse：只在累积足够数据时才尝试解析，避免 O(N²) 卡顿
        if (lastFc.partialArgs.trim() && shouldAttemptParse(lastFc, lastFc.partialArgs.length)) {
          try {
            lastFc.args = JSON.parse(lastFc.partialArgs)
          } catch (e) { /* 继续累积 */ }
          // 无论成功与否，lastParseLen 已在 shouldAttemptParse 中更新
        }

        // ★ 同步更新 message.tools 中对应工具的流式状态和 partialArgs
        const toolId = lastFc.id
        if (toolId) {
          const toolEntry = message.tools?.find(t => t.id === toolId)
          if (toolEntry) {
            toolEntry.status = 'streaming'
            toolEntry.partialArgs = lastFc.partialArgs
            // 同步已解析的 args（用于描述格式化器预览）
            if (lastFc.args && Object.keys(lastFc.args).length > 0) {
              toolEntry.args = lastFc.args
            }
          }
        }
      } else if (fc.args && Object.keys(fc.args).length > 0) {
        lastFc.args = { ...lastFc.args, ...fc.args }

        // 收到完整 args 后，认为该次增量拼接已收束，
        // 清理残留 partialArgs，避免后续相同 index 的新工具调用被误合并。
        if (lastFc.partialArgs) {
          delete lastFc.partialArgs
        }
      }

      // 工具参数接收完毕：同步 message.tools 状态和 args
      const resolvedId = lastFc.id
      if (resolvedId && !lastFc.partialArgs && lastFc.args && Object.keys(lastFc.args).length > 0) {
        const toolEntry = message.tools?.find(t => t.id === resolvedId)
        if (toolEntry && toolEntry.status === 'streaming') {
          toolEntry.status = 'queued'
          toolEntry.args = lastFc.args
          delete toolEntry.partialArgs
        }
      }
      
      merged = true
    }
  }
  
  if (!merged) {
    if (isTodoToolName(fc.name)) {
      debugTodoOnce(`append-${message.id}-${fc.id || 'no-id'}-${String(fc.name)}`, {
        messageId: message.id,
        action: 'append_new_function_call_part',
        incomingName: fc.name,
        incomingId: typeof fc.id === 'string' ? fc.id : null,
        incomingIndex: fc.index ?? null,
        hasPartial: typeof fc.partialArgs === 'string',
        hasArgs: !!(fc.args && Object.keys(fc.args).length > 0)
      })
    }

    // 找不到可合并的，添加新块
    addFunctionCallToMessage(message, {
      id: fc.id || generateId(),
      name: fc.name || '',
      args: fc.args || {},
      partialArgs: fc.partialArgs,
      index: fc.index
    })
  }
}
