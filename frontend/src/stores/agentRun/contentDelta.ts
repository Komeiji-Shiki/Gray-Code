/**
 * WP15: SubAgent Monitor Content[] delta reducer。
 *
 * 为什么需要这个文件：SubAgent Monitor 不能直接使用主聊天的 handleFunctionCallPart（它耦合了Message 类型和
 * Pinia store 状态），但需要相同的 functionCall 合并语义（itemId > index > id > freshPlaceholder > legacyPartial）。
 *
 * 怎么改：合并逻辑（normalizeNonEmptyString、hasNonEmptyArgs、tryParseArgs、getFunctionCallMergeReason。
 * mergeFunctionCall）已收敛到utils/functionCallMerge.ts。本文件只保留Monitor 特有的Content[] 投影逻辑：
 * cloneContent、appendContentPart、ensureLastModelContent、applyStreamChunkToContents。
 *
 * 目的：Main Chat 和SubAgent Monitor 共享同一套functionCall 合并规则，后续WP20 统一 reducer 可直接依赖。
 */

import type { Content, ContentPart } from '../../types'
// WP15: 统一 functionCall merge 纯函数入口。
// 为什么从独立模块导入：消除与 streamHelpers.ts / parsers.ts 的三份重复。
// 怎么改：getFunctionCallMergeReason 和mergeFunctionCall 直接引用统一模块。
// 目的：Monitor 实时工具卡合并行为与主聊天完全一致。
import {
  type StreamFunctionCall,
  hasNonEmptyArgs,
  getFunctionCallMergeReason,
  mergeFunctionCall as unifiedMergeFunctionCall
} from '../../utils/functionCallMerge'

function cloneContent(content: Content): Content {
  // 修改原因：只有即将被替换或被 delta 更新的Content 需要深拷贝 parts，未变化的历史楼层应保持引用共享。
  // 修改方式：保留单 Content 深拷贝工具，但不再在 applyStreamChunkToContents 中对整个 contents 全量 map 调用。
  // 目的：大输出流式阶段避免每个 delta clone 所有旧消息对象，降低Monitor 本地 reducer 的O(n²) 风险。
  return {
    ...content,
    parts: (content.parts || []).map(part => {
      const cloned: ContentPart = { ...part }
      if (part.functionCall) cloned.functionCall = { ...(part.functionCall as StreamFunctionCall) } as ContentPart['functionCall']
      if (part.functionResponse) cloned.functionResponse = { ...part.functionResponse }
      return cloned
    })
  }
}

/**
 * WP15: Monitor 专用的mergeFunctionCall 薄包装。
 *
 * 为什么需要这个包装：Monitor 的live delta 不需要Main Chat 的JSON.parse 节流策略，
 * 只在 finalArgs=true（流式完成事件）时解析partialArgs。
 * 怎么改：不传 shouldParseArgs，让统一模块使用默认的finalArgs-only 解析策略。
 * 目的：Monitor 大工具参数不跑不必要的JSON.parse 循环，同时共享同一合并语义。
 */
function mergeFunctionCall(target: StreamFunctionCall, incoming: StreamFunctionCall): void {
  unifiedMergeFunctionCall(target, incoming)
}

function appendFunctionCallPart(parts: ContentPart[], incomingPart: ContentPart): void {
  const incoming = incomingPart.functionCall as StreamFunctionCall | undefined
  if (!incoming) return

  let isLastFunctionCall = true
  for (let i = parts.length - 1; i >= 0; i--) {
    const existing = parts[i].functionCall as StreamFunctionCall | undefined
    if (!existing) continue

    const reason = getFunctionCallMergeReason(incoming, existing, isLastFunctionCall)
    if (reason) {
      mergeFunctionCall(existing, incoming)
      return
    }

    isLastFunctionCall = false
  }

  const newFunctionCall: StreamFunctionCall = {
    ...(incoming as any),
    name: incoming.name || '',
    args: hasNonEmptyArgs(incoming.args) ? incoming.args : {}
  }
  mergeFunctionCall(newFunctionCall, incoming)
  parts.push({ functionCall: newFunctionCall as ContentPart['functionCall'] })
}

function appendContentPart(target: Content, part: ContentPart): void {
  if (part.text !== undefined) {
    const lastPart = target.parts[target.parts.length - 1]
    const isThought = part.thought === true
    const lastIsThought = lastPart?.thought === true
    if (lastPart && lastPart.text !== undefined && !lastPart.functionCall && lastIsThought === isThought) {
      lastPart.text += part.text
    } else {
      target.parts.push(isThought ? { text: part.text, thought: true } : { text: part.text })
    }
    return
  }

  if (part.functionCall) {
    appendFunctionCallPart(target.parts, part)
    return
  }

  target.parts.push({ ...part })
}

function ensureLastModelContent(contents: Content[], timestamp: number, baseIndex: number): Content {
  const last = contents[contents.length - 1]
  if (last?.role === 'model') {
    return last
  }

  // 修改原因：SubAgent Monitor 可能先收到llm_delta，再收到最终content_snapshot；没有model 楼层时必须先创建一个本地live baseline。
  // 修改方式：在 contents 末尾补一个role=model 的空 Content，并只作为前端实时投影使用。
  // 目的：让 Monitor 能像主聊天一样边收边渲染，而不是等 run 完成后才显示 AI 输出。
  const created = {
    role: 'model' as const,
    parts: [],
    timestamp,
    // 修改原因：Monitor window 可能不是从0 开始；新建 live model 楼层必须保留完整 transcript 的绝对index。
    // 修改方式：由调用方传入window.startIndex 作为 baseIndex，默认0 兼容单元测试和旧调用。
    // 目的：delete/retry/backendIndex 不因实时 delta 在分页窗口内生成局部index 而错位。
    index: baseIndex + contents.length
  } as Content
  contents.push(created)
  return created
}

export interface AgentRunStreamChunkLike {
  contentSnapshot?: Content
  delta?: ContentPart[]
  usage?: Content['usageMetadata']
  modelVersion?: string
  thinkingStartTime?: number
}

export interface AgentRunStreamUpdate {
  chunk: AgentRunStreamChunkLike | undefined | null
  timestamp: number
}

// 同一流式基线之前的历史保持不变。只保留身份与变化起点，不串联旧数组以免长期保留每帧快照。
const streamContentChanges = new WeakMap<Content[], { lineage: object; start: number; snapshotVersion: number }>()

export function getStreamContentChangeStart(previous: Content[], next: Content[]): number | undefined {
  if (previous === next) return next.length
  const before = streamContentChanges.get(previous)
  const after = streamContentChanges.get(next)
  return before && after && after.lineage === before.lineage ? after.start : undefined
}

/** 只有同一基线上的纯追加才能按长度取显示增量；权威快照必须重新建立真实文本基线。 */
export function isAppendOnlyStreamChange(previous: Content[], next: Content[]): boolean {
  const before = streamContentChanges.get(previous)
  const after = streamContentChanges.get(next)
  return !!before && !!after && before.lineage === after.lineage && before.snapshotVersion === after.snapshotVersion
}

export function applyStreamChunkToContents(
  contents: Content[], chunk: AgentRunStreamChunkLike | undefined | null,
  timestamp: number = Date.now(), baseIndex: number = 0
): Content[] {
  return applyStreamUpdatesToContents(contents, [{ chunk, timestamp }], baseIndex)
}

/** 同一批片段按原顺序应用，已经复制的尾消息可继续写入，快照边界仍保留完整语义。 */
export function applyStreamUpdatesToContents(contents: Content[], updates: readonly AgentRunStreamUpdate[], baseIndex = 0): Content[] {
  const source = contents
  const next = [...source]
  const writable = new Set<Content>()
  const baseline = streamContentChanges.get(source) ?? { lineage: {}, start: source.length, snapshotVersion: 0 }
  streamContentChanges.set(source, baseline)
  let changedFrom = baseline.start
  let snapshotVersion = baseline.snapshotVersion

  for (const { chunk, timestamp } of updates) {
    const snapshot = chunk?.contentSnapshot as Content | undefined
    if (snapshot?.parts) {
      snapshotVersion++
      const replacement = cloneContent({
        ...snapshot,
        timestamp: snapshot.timestamp || timestamp,
        index: typeof snapshot.index === 'number' ? snapshot.index : baseIndex + Math.max(0, next.length - 1)
      } as Content)
      let lastModelIndex = -1
      for (let index = next.length - 1; index >= 0; index--) {
        if (next[index]?.role === 'model') {
          lastModelIndex = index
          break
        }
      }
      if (lastModelIndex === next.length - 1 && lastModelIndex >= 0) {
        // 同一模型消息的结构快照可缺省 ID，继续保留已知身份用于阅读锚点。
        if (replacement.id === undefined) replacement.id = next[lastModelIndex].id
        next[lastModelIndex] = replacement
        changedFrom = Math.min(changedFrom, lastModelIndex)
      } else {
        // 工具结果之后的快照属于下一条模型消息，不能覆盖前一条已经完成的调用。
        replacement.index = baseIndex + next.length
        changedFrom = Math.min(changedFrom, next.length)
        next.push(replacement)
      }
      writable.add(replacement)
      continue
    }

    const lastIndex = next.length - 1
    let modelContent: Content
    if (lastIndex >= 0 && next[lastIndex]?.role === 'model') {
      modelContent = next[lastIndex]
      if (!writable.has(modelContent)) {
        modelContent = cloneContent(modelContent)
        next[lastIndex] = modelContent
        writable.add(modelContent)
      }
      changedFrom = Math.min(changedFrom, lastIndex)
    } else {
      changedFrom = Math.min(changedFrom, next.length)
      modelContent = ensureLastModelContent(next, timestamp, baseIndex)
      writable.add(modelContent)
    }

    for (const part of chunk?.delta || []) appendContentPart(modelContent, part)
    if (chunk?.usage) modelContent.usageMetadata = chunk.usage
    if (chunk?.modelVersion) modelContent.modelVersion = chunk.modelVersion
    if (chunk?.thinkingStartTime) modelContent.thinkingStartTime = chunk.thinkingStartTime
  }

  streamContentChanges.set(next, { lineage: baseline.lineage, start: changedFrom, snapshotVersion })
  return next
}
