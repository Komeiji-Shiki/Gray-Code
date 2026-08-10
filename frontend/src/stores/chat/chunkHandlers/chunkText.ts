/**
 * 流式 Chunk 处理器 —— text/delta/usage/smooth 相关
 *
 * 拆分自 streamChunkHandlers.ts（模块化重构第 4 批，纯移动、逻辑不改）。
 *
 * 本文件持有本组模块级状态（单例，禁止在文件间复制）：
 * - fcSeenBodies：工具调用参数的 TPS 已计文本跟踪
 * - smoothBaseCache：平滑基线缓存
 * - activeModelKey / activeFactor / turnBaseTokens：TPS 校准上下文
 * chunkTools / chunkTerminal 通过本文件导出复用这些状态与共享辅助函数。
 */

import type { Content, Message, StreamChunk, ToolUsage } from '../../../types'
import type { ChatStoreState } from '../types'
import { tpsMeter } from '../../../utils/tpsMeter'
import { pushSmoothText, finishSmoothStream, migrateSmoothStream } from '../smoothStreamManager'
import { contentToMessage, contentToMessageEnhanced } from '../parsers'
import { addTextToMessage, processStreamingText, handleFunctionCallPart } from '../streamHelpers'
import { getMessageIndexById, replaceMessageAt } from '../state'
import type { StreamFunctionCall } from '../../../utils/functionCallMerge'
import { calibrate, countBaseTokens, ensureTokenCounterLoaded, getCalibrationFactor, isTokenizerReady } from '../../../utils/tokenCounter'

/**
 * 工具调用参数的 TPS 已计文本跟踪（per-tool call id）。
 * 用途：① OpenAI Responses 的 finalArgs 事件携带完整 JSON 且与前面的 delta 增量重复，
 * 用「已见文本」只计增量差值，防止同一份参数 JSON 被计两次；
 * ② 工具参数也按真实 tokenizer 计数（JSON 标点密集，字符粗估会把 1 token 估成 ~2）。
 * 有界：流结束（done）时清空；容量超限时整体清空兜底。
 */
export const fcSeenBodies = new Map<string, string>()
const MAX_FC_SEEN_TRACKED = 200

/**
 * 平滑基线缓存：messageId → 上次计算的 slice 基线文本。
 * 流式期间 partText 只增不减（增量追加），partText 仍以缓存基线开头时，
 * 新基线 = 缓存基线 + 中间增量切片，避免每 chunk 对全串 slice（O(n) 展开）。
 * 段落切换/权威快照/流终结时由 finishSmoothStreamForState 清理；容量超限整体清空兜底。
 */
const smoothBaseCache = new Map<string, string>()
const MAX_SMOOTH_BASE_TRACKED = 200

/** 当前流使用的模型与校准因子（模型切换时重新读取） */
let activeModelKey = ''
let activeFactor = 1
/** 本轮（当前 API 调用流）累计的 base token 估算，流结束用于校准 */
let turnBaseTokens = 0

/**
 * 清空本轮 base 估算（本地取消路径使用）：后端此后可能不发任何终结 chunk（挂死/断网），
 * 残留估算会混入下一轮流（realTokens 是新流真值、base 混入旧流字符）拉偏校准因子。
 * handleCancelled/handleError 的终结路径同样调用本函数清空（拆分后位于 chunkTerminal）。
 */
export function resetTurnBaseTokenEstimate(): void {
  turnBaseTokens = 0
}

/** 从会话状态解析当前模型 key（与 checkpointActions 的 resolveConversationModelOverride 同口径） */
function resolveModelKey(state: ChatStoreState): string {
  const selected = state.selectedModelId?.value?.trim() ?? ''
  if (selected) return selected
  const model = state.currentConfig?.value?.model?.trim() ?? ''
  return model || 'default'
}

/** 模型变化时重新读取校准因子并触发对应 tokenizer 懒加载 */
function syncModelContext(state: ChatStoreState): void {
  const modelKey = resolveModelKey(state)
  if (modelKey === activeModelKey) return
  activeModelKey = modelKey
  activeFactor = getCalibrationFactor(modelKey)
  ensureTokenCounterLoaded(modelKey)
}

/** record：base 估算 × 校准因子；同时累计 base 供流结束校准。
 * source 标记当前计数方式：模型 tokenizer 就绪 → 真实计数，否则 → 字符加权估算。 */
function recordTpsTokens(base: number, ts?: number): void {
  if (base <= 0) return
  turnBaseTokens += base
  tpsMeter.record(
    Math.max(1, Math.round(base * activeFactor)),
    ts,
    isTokenizerReady(activeModelKey) ? 'tokenizer' : 'estimate'
  )
}

/**
 * 把后端已持久化的 Content 投影为消息，并用稳定节点 ID 替换前端流式占位 ID。
 *
 * 旧后端没有回传 content.id 时保留占位 ID；新后端回传稳定 ID 时同步
 * streamingMessageId，保证后续工具状态/确认事件仍能定位到同一条消息。
 * （供 chunkTools / chunkTerminal 复用，不对外 re-export）
 */
export function contentToPersistedMessage(content: Content, currentMessage: Message, state: ChatStoreState): Message {
  const persistedId = typeof content.id === 'string' && content.id.trim()
    ? content.id
    : currentMessage.id
  const persistedMessage = contentToMessage(content, persistedId)

  if (persistedId !== currentMessage.id && state.streamingMessageId.value === currentMessage.id) {
    state.streamingMessageId.value = persistedId
    // H1：平滑显示层键随占位 id → 持久化 id 迁移，避免按新 id 终结清理时残留旧条目
    migrateSmoothStreamForState(state, currentMessage.id, persistedId)
  }
  return persistedMessage
}

/**
 * 合并工具列表：以 incoming（按 AI 输出顺序）为基准，尽量保留 existing 中的运行态字段。
 *
 * 目标：避免 toolsExecuting/awaitingConfirmation/toolIteration 阶段用 contentToMessage 生成的
 * "queued" 覆盖掉 toolStatus 写入的真实状态/结果。
 *
 * 匹配策略（按优先级）：id > index > itemId。
 * 当 id 不一致但 index/itemId 一致时（Anthropic 等渠道 id 延迟到达），仍能正确合并，
 * 避免流式过程中出现重复的工具调用框。
 * （供 chunkTools 复用，不对外 re-export）
 */
export function mergeToolsPreferExisting(
  existing: ToolUsage[] | undefined,
  incoming: ToolUsage[] | undefined
): ToolUsage[] | undefined {
  const a = existing || []
  const b = incoming || []
  if (a.length === 0) return b.length > 0 ? b : undefined
  if (b.length === 0) return a.length > 0 ? a : undefined

  // 构建多维度索引
  const byId = new Map<string, ToolUsage>()
  const byIndex = new Map<number, ToolUsage>()
  const byItemId = new Map<string, ToolUsage>()
  for (const t of a) {
    if (t && typeof t.id === 'string') byId.set(t.id, t)
    const idx = (t as any).index
    if (typeof idx === 'number') byIndex.set(idx, t)
    const iid = typeof (t as any).itemId === 'string' && (t as any).itemId.trim() ? (t as any).itemId.trim() : ''
    if (iid) byItemId.set(iid, t)
  }

  const consumed = new Set<ToolUsage>()
  const merged: ToolUsage[] = []

  for (const t of b) {
    // 1) 按 id 匹配
    let e = byId.get(t.id)
    // 2) 按 index 匹配（type number，包括 0）
    if (!e) {
      const idx = (t as any).index
      if (typeof idx === 'number') e = byIndex.get(idx)
    }
    // 3) 按 itemId 匹配
    if (!e) {
      const iid = typeof (t as any).itemId === 'string' && (t as any).itemId.trim() ? (t as any).itemId.trim() : ''
      if (iid) e = byItemId.get(iid)
    }

    if (!e) {
      merged.push(t)
      continue
    }

    consumed.add(e)

    const incomingHasArgs = !!(t.args && Object.keys(t.args).length > 0)
    const partialArgs = typeof t.partialArgs === 'string'
      ? (typeof e.partialArgs === 'string' && e.partialArgs.length > t.partialArgs.length ? e.partialArgs : t.partialArgs)
      : (incomingHasArgs ? undefined : e.partialArgs)

    let status = e.status ?? t.status
    if (!partialArgs && incomingHasArgs && status === 'streaming') {
      status = 'queued'
    }

    // incoming 提供更完整的 name/args/id；existing 提供更可信的 status/result/error/duration
    merged.push({
      ...e,
      ...t,
      status,
      result: e.result ?? t.result,
      error: e.error ?? t.error,
      duration: e.duration ?? t.duration,
      awaitingConfirmation: e.awaitingConfirmation ?? t.awaitingConfirmation,
      partialArgs
    })
  }

  // 兜底：只保留 existing 中未被任何 incoming 匹配到的工具
  for (const t of a) {
    if (!consumed.has(t)) {
      merged.push(t)
    }
  }

  return merged.length > 0 ? merged : undefined
}

function buildMessageFromContentSnapshot(currentMessage: Message, snapshotContent: NonNullable<StreamChunk['chunk']>['contentSnapshot']): Message {
  const existingModelVersion = currentMessage.metadata?.modelVersion
  const snapshotMessage = contentToMessageEnhanced(snapshotContent!, currentMessage.id)
  let mergedTools = mergeToolsPreferExisting(currentMessage.tools, snapshotMessage.tools)

  const updatedMessage: Message = {
    ...currentMessage,
    ...snapshotMessage,
    id: currentMessage.id,
    timestamp: currentMessage.timestamp,
    backendIndex: currentMessage.backendIndex,
    localOnly: currentMessage.localOnly,
    streaming: currentMessage.streaming,
    // 三级 fallback：合并结果 > snapshot 提取的 tools > 已有的 tools
    // 确保 snapshot 重建不会因为 merge 结果为空而丢失工具信息
    tools: (mergedTools && mergedTools.length > 0)
      ? mergedTools
      : (snapshotMessage.tools && snapshotMessage.tools.length > 0 ? snapshotMessage.tools : currentMessage.tools)
  }

  if (!updatedMessage.metadata) {
    updatedMessage.metadata = {}
  }

  if (existingModelVersion) {
    updatedMessage.metadata.modelVersion = existingModelVersion
  }

  return updatedMessage
}

/**
 * 平滑流式：真实内容已累加（addTextToMessage / processStreamingText），
 * 这里把增量文本送入显示层蓄水池（SmoothStreamer）；TPS 等指标吃真实 chunk，不经此层。
 * 段落身份（thought/text + part 索引）变化时由 manager 自动重置蓄水池。
 */
function pushSmoothTextForMessage(message: Message, deltaText: string, state: ChatStoreState): void {
  // M1：档位经 state.smoothMode 传递（chatStore watch settingsStore 同步），
  // 不再每 chunk 内联 useSettingsStore()；测试 mock 状态缺字段时兜底 'off'。
  const mode = state.smoothMode?.value ?? 'off'
  if (!deltaText) return
  if (mode === 'off') {
    // H3 on→off：档位切回直通时立即放完积压并销毁实例，UI 切回真实 content
    finishSmoothStreamForState(state, message.id)
    return
  }
  // M5：非 streaming 消息不写平滑层（与 MessageItem 的 isStreaming 门控对齐）
  if (message.streaming !== true) return
  const parts = message.parts
  if (!parts || parts.length === 0) return
  const lastPart = parts[parts.length - 1]
  if (typeof lastPart.text !== 'string') return
  // H2-A：新段落前导空白（该 part 尚无可见文本）不推入显示层——flushText 因 trim 为空
  // 不会为其生成块，推入会让平滑文本覆盖上一段已完成块（消失→重现闪烁）。
  if (!lastPart.text.trim()) return
  const partKey = `${lastPart.thought === true ? 'thought' : 'text'}:${parts.length - 1}`
  // H3 off→on / 段落切换：显示基线 = 当前 part 已累计真实文本（不含本次 delta），
  // 首次 commit 时 displayText = baseText + delta，与已渲染真实内容连续、不跳变。
  const partText = lastPart.text
  if (!partText.endsWith(deltaText)) {
    // 权威快照或异常合并使“本次 delta 位于尾部”的前提失效时，不能继续拼接错误基线。
    // 立即结束旧显示层并回到真实 parts；下一次可验证的 delta 会从当前真实文本重建。
    smoothBaseCache.delete(message.id)
    finishSmoothStreamForState(state, message.id)
    return
  }
  // 增量基线：partText 仍以缓存基线开头时（流式期间几乎总是成立），
  // 新基线 = 缓存基线 + 中间增量片段，跳过对全串的 slice 展开
  const baseTextLen = partText.length - deltaText.length
  const cachedBase = smoothBaseCache.get(message.id)
  const baseText = cachedBase !== undefined && partText.startsWith(cachedBase)
    ? cachedBase + partText.slice(cachedBase.length, baseTextLen)
    : partText.slice(0, baseTextLen)
  smoothBaseCache.set(message.id, baseText)
  if (smoothBaseCache.size > MAX_SMOOTH_BASE_TRACKED) {
    smoothBaseCache.clear()
  }
  pushSmoothText(message.id, partKey, deltaText, mode, baseText, (messageIdAtSnapshot, partKeyAtSnapshot, displayText) => {
    // M3+：快照由 manager 低频节流（~120ms），这里只在值变化时写 store.smoothTexts；
    // 高频动画路径走 manager → CharFlow 直连（手动 DOM），不经 Vue 响应式链。
    // messageIdAtSnapshot 来自 manager 当前 entry，持久化 id 迁移后不会把旧占位键重新写回来。
    const prev = state.smoothTexts.get(messageIdAtSnapshot)
    if (!prev || prev.partKey !== partKeyAtSnapshot || prev.text !== displayText) {
      state.smoothTexts.set(messageIdAtSnapshot, { partKey: partKeyAtSnapshot, text: displayText })
    }
  })
}

/**
 * H1：平滑显示层条目随消息 id 迁移（占位 id → 后端持久化 id）。
 * manager entry 与 smoothTexts 键同步改名，终结清理按新 id 即可命中，不残留旧条目。
 * （供 chunkTerminal 复用，不对外 re-export）
 */
export function migrateSmoothStreamForState(state: ChatStoreState, fromId: string, toId: string): void {
  migrateSmoothStream(fromId, toId)
  const text = state.smoothTexts?.get(fromId)
  if (text !== undefined) {
    state.smoothTexts.delete(fromId)
    state.smoothTexts.set(toId, text)
  }
}

/**
 * 终结清理：放完积压（不丢尾巴）、销毁实例并删除显示文本，UI 切回真实 content。
 * 同时清理传入 id 与当前 streamingMessageId（cancelled 可能把占位 id 替换为后端持久化 id）。
 */
export function finishSmoothStreamForState(state: ChatStoreState, messageId?: string | null): void {
  const ids = new Set<string>()
  if (messageId) ids.add(messageId)
  if (state.streamingMessageId.value) ids.add(state.streamingMessageId.value)
  for (const id of ids) {
    finishSmoothStream(id)
    smoothBaseCache.delete(id)
    // smoothTexts 为本模块新增的显示层字段；测试 mock 状态可能不含它，缺失时跳过清理
    state.smoothTexts?.delete(id)
  }
}

/**
 * 清空状态中所有平滑条目（清空会话/重置/关闭标签页等本地重置路径用）：
 * 先放完当前流积压并销毁实例，再清空 smoothTexts，UI 立即切回真实 content。
 */
export function clearAllSmoothForState(state: ChatStoreState): void {
  finishSmoothStreamForState(state)
  smoothBaseCache.clear()
  for (const id of Array.from(state.smoothTexts?.keys() ?? [])) {
    finishSmoothStream(id)
    state.smoothTexts?.delete(id)
  }
}

/**
 * 处理 chunk 类型
 */
export function handleChunkType(chunk: StreamChunk, state: ChatStoreState): void {
  syncModelContext(state)
  const messageIndex = getMessageIndexById(state, state.streamingMessageId.value)
  if (messageIndex === -1 || !chunk.chunk) {
    return
  }

  const snapshotContent = chunk.chunk.contentSnapshot
  if (snapshotContent) {
    // contentSnapshot 表示后端发生了纯文本 delta 无法表达的权威变更（如工具结构变化）。
    // 旧 entry 的 baseText/partKey 已不再可靠，先终结显示层并切回真实快照；下一条普通
    // 文本 delta 会以快照内容为新基线重新创建 CharFlow。
    finishSmoothStreamForState(state, state.streamingMessageId.value)
    const updatedMessage = buildMessageFromContentSnapshot(state.allMessages.value[messageIndex], snapshotContent)
    replaceMessageAt(state, messageIndex, updatedMessage)
  }

  const message = state.allMessages.value[messageIndex]
  if (chunk.chunk.delta) {
    // 流式 delta 统一经 replaceMessageAt 写回数组（state.ts 层维护索引 / 可见缓存不变量）：
    // 先在浅拷贝上做增量（parts/tools 数组复制、part 对象共享），结束时整体替换，
    // 避免绕过 state.ts 写 API 的原地 mutate 造成引用漂移（UI 缓存持有旧对象时读到陈旧内容）。
    const nextMessage: Message = {
      ...message,
      parts: message.parts ? [...message.parts] : undefined,
      tools: message.tools ? [...message.tools] : undefined,
      metadata: message.metadata ? { ...message.metadata } : undefined
    }

    // 初始化 parts（如果不存在）
    if (!nextMessage.parts) {
      nextMessage.parts = []
    }
    
    // 没有快照时，按增量追加；有快照时，以快照为准，跳过旧的本地文本猜测逻辑
    if (!snapshotContent) {
      for (const part of chunk.chunk.delta) {
        if (part.text) {
          // TPS 实时可视化：thought 与正文都是模型输出（思考速度也是生成速度的一部分），
          // 统一按模型专属 tokenizer 计数 × 自校准因子（懒加载完成前回退字符加权估算）。
          // 时间戳用 chunk.createdAt——后台积压回放的 chunk 按原始发生时间入窗并被窗口
          // 立即修剪，不产生回放尖峰。
          recordTpsTokens(
            countBaseTokens(part.text, activeModelKey),
            typeof chunk.createdAt === 'number' ? chunk.createdAt : undefined
          )
          if (part.thought) {
            addTextToMessage(nextMessage, part.text, true)
          } else {
            processStreamingText(nextMessage, part.text, state)
          }
          // 平滑显示层：真实内容已累加，这里驱动打字节奏（关闭时直通，无副作用）
          pushSmoothTextForMessage(nextMessage, part.text, state)
        }

        // 处理工具调用（原生 function call format）
        // 工具参数 JSON 也是模型的输出，必须计入生成速度；文本按真实 tokenizer 精确计数
        // （JSON 标点/结构字符压缩率高，字符粗估会把 1 token 估成 ~2 token）。
        // OpenAI Responses 的 finalArgs 事件携带完整 JSON 且与前面的 delta 增量重复：
        // 用 per-tool 已见文本只计增量差值，finalArgs 到达时文本不再增长 → 不重复计。
        if (part.functionCall) {
          const fc = part.functionCall as StreamFunctionCall
          const fcName = typeof fc.name === 'string' ? fc.name : ''
          const fcBody = typeof fc.partialArgs === 'string'
            ? fc.partialArgs
            : (fc.args && typeof fc.args === 'object' ? JSON.stringify(fc.args) : '')
          const recordTs = typeof chunk.createdAt === 'number' ? chunk.createdAt : undefined
          const fcKey = typeof fc.id === 'string' && fc.id.length > 0 ? fc.id : null
          if (fcKey) {
            const lastBody = fcSeenBodies.get(fcKey)
            if (lastBody === undefined) {
              // 首次到达：函数名 + 当前参数体（finalArgs 整块场景一次计全）
              recordTpsTokens(countBaseTokens(fcName, activeModelKey) + countBaseTokens(fcBody, activeModelKey), recordTs)
            } else if (fcBody.length >= lastBody.length) {
              // 增量追加（partialArgs 流式语义）：只计新增部分
              const deltaText = fcBody.slice(lastBody.length)
              if (deltaText) {
                recordTpsTokens(countBaseTokens(deltaText, activeModelKey), recordTs)
              }
            } else {
              // 长度回退（快照/结构重置）：按当前全量重计
              recordTpsTokens(countBaseTokens(fcBody, activeModelKey), recordTs)
            }
            fcSeenBodies.set(fcKey, fcBody)
            if (fcSeenBodies.size > MAX_FC_SEEN_TRACKED) {
              fcSeenBodies.clear()
            }
          } else {
            // 无稳定 call id（罕见）：按完整长度计一次
            recordTpsTokens(countBaseTokens(fcName, activeModelKey) + countBaseTokens(fcBody, activeModelKey), recordTs)
          }
          handleFunctionCallPart(part, nextMessage)
        }
      }
    }
    
    // 更新 token 信息和计时信息
    if (!nextMessage.metadata) {
      nextMessage.metadata = {}
    }
    
    // 如果 chunk 包含 thinkingStartTime，更新 metadata（用于实时显示思考时间）
    if ((chunk.chunk as any).thinkingStartTime) {
      nextMessage.metadata.thinkingStartTime = (chunk.chunk as any).thinkingStartTime
    }
    
    // 如果是最后一个 chunk（done=true），更新 token 信息
    // 注意：modelVersion 保持创建时的值，不从 API 响应更新
    if (chunk.chunk.done) {
      // 本轮流输出结束：所有工具参数已到达，清空增量计数跟踪
      fcSeenBodies.clear()
      // 校准：用本次 API 调用的最终 usage 真值对比本轮 base 估算。
      // 口径说明：candidatesTokenCount 在 Anthropic（output_tokens）与多数 OAI 兼容渠道
      // （completion_tokens）中已包含思考 token（tokenRate.ts 同口径），而估算端
      // countBaseTokens 同样计入 thought 文本——两边都含思考，直接对齐，不再减
      // thoughtsTokenCount（剔除会让真值偏小、校准因子被压低，TPS 显示反而偏低）。
      const finalUsage = chunk.chunk.usage
      if (finalUsage && turnBaseTokens > 0) {
        const realTokens = typeof finalUsage.candidatesTokenCount === 'number'
          ? finalUsage.candidatesTokenCount
          : 0
        if (realTokens > 0) {
          calibrate(activeModelKey, turnBaseTokens, realTokens)
        }
      }
      turnBaseTokens = 0
      // 兜底：AI 输出结束，所有 streaming 工具应已完成参数输出
      if (nextMessage.tools) {
        for (const tool of nextMessage.tools) {
          if (tool.status === 'streaming') {
            tool.status = 'queued'
            // 清理流式预览状态
            delete tool.partialArgs
            // 从 parts 同步最终 args
            const matchingPart = nextMessage.parts?.find(
              p => p.functionCall && p.functionCall.id === tool.id
            )
            if (matchingPart?.functionCall?.args) {
              tool.args = matchingPart.functionCall.args
            }
          }
        }
      }

      if (chunk.chunk.usage) {
        nextMessage.metadata.usageMetadata = chunk.chunk.usage
        nextMessage.metadata.thoughtsTokenCount = chunk.chunk.usage.thoughtsTokenCount
        nextMessage.metadata.candidatesTokenCount = chunk.chunk.usage.candidatesTokenCount
      }
    }

    // 写回数组：id 不变（不重建索引），replaceMessageAt 维护窗口可见缓存不变量
    replaceMessageAt(state, messageIndex, nextMessage)
  }
}
