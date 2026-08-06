import type { ChatStoreState } from './types'
import type { Message } from '../../types'
import { perfLog } from '../../utils/perf'
import { replaceAllMessages } from './state'

/** 默认消息窗口上限（按可见消息预算计算，保留完整轮次） */
export const MAX_WINDOW_MESSAGES = 800

interface WindowRound {
  startIndex: number
  endIndex: number
  visibleCount: number
}

function isVisibleWindowMessage(message: Message): boolean {
  return message.isFunctionResponse !== true
}

/**
 * 可见消息增量缓存（HIS-12）。
 *
 * 背景：messages computed 对流式期间的每次 chunk 变更都会全窗口重扫
 * （≤800 条 filter），形成 O(n) / chunk 的扫描成本。
 *
 * 正确性依据（本仓库的变更模式）：
 * - 消息的可见性（isFunctionResponse）在消息对象创建后不变；
 * - 流式期间 replaceMessageAt 只原地替换“流式消息”（窗口最后一个元素，同 id 同长度）；
 * - 追加/删除/整体替换都会改变数组引用或长度；
 * - 中间位置的同长度替换会命中陈旧缓存（指纹只校验首尾元素）——state.replaceMessageAt 在
 *   index !== length-1 时主动 clearVisibleChatMessagesCache（L1），其余修改全部产生新数组引用。
 *
 * 因此缓存可用 (sourceRef, sourceLength, first, last) 四个 O(1) 指纹验证：
 * 指纹不匹配 → 全量重建；仅尾部追加 → 只过滤新增尾部；仅尾部替换 → 原地更新缓存尾元素。
 * 任何指纹变化（含未知变更）都回退全量 filter，不产生陈旧数据。
 */
interface VisibleMessagesCacheEntry {
  source: Message[]
  sourceLength: number
  firstSourceElement: Message | undefined
  lastSourceElement: Message | undefined
  visible: Message[]
}

const visibleMessagesCache = new WeakMap<ChatStoreState, VisibleMessagesCacheEntry>()

export function getVisibleChatMessagesCached(state: ChatStoreState): Message[] {
  const source = state.allMessages.value
  const cached = visibleMessagesCache.get(state)

  const buildFull = (): Message[] => {
    const visible = source.filter(isVisibleWindowMessage)
    visibleMessagesCache.set(state, {
      source,
      sourceLength: source.length,
      firstSourceElement: source[0],
      lastSourceElement: source[source.length - 1],
      visible
    })
    return visible
  }

  if (!cached || cached.source !== source) {
    return buildFull()
  }

  if (source.length < cached.sourceLength) {
    // 有元素被移除（splice / 截断 / 未知变更）：全量重建
    return buildFull()
  }

  if (source.length === cached.sourceLength) {
    // 同长度：首元素变化 = 未知结构性变更 → 重建；
    // 仅尾部元素被替换（流式原地更新，同 id）→ 可见性不变，只把缓存尾元素指向新对象
    if (source[0] !== cached.firstSourceElement) {
      return buildFull()
    }
    const newLast = source[source.length - 1]
    if (newLast === cached.lastSourceElement) {
      // 完全未变（Vue 重复求值）：直接返回缓存
      return cached.visible
    }
    const oldLast = cached.lastSourceElement
    const lastVisibleIndex = cached.visible.length - 1
    if (lastVisibleIndex >= 0 && cached.visible[lastVisibleIndex] === oldLast) {
      if (isVisibleWindowMessage(newLast)) {
        // 尾元素仍是可见消息：原地替换引用
        const nextVisible = cached.visible.slice()
        nextVisible[lastVisibleIndex] = newLast
        visibleMessagesCache.set(state, {
          source,
          sourceLength: source.length,
          firstSourceElement: source[0],
          lastSourceElement: newLast,
          visible: nextVisible
        })
        return nextVisible
      }
      // 尾元素从可见变为不可见（防御：正常流式不会发生）→ 重建
      return buildFull()
    }
    // 尾元素之前缓存里没有它（异常态）→ 重建
    return buildFull()
  }

  // 长度增长：可能是纯尾部追加，也可能是“尾部替换 + 追加”等组合。
  // 若旧尾元素身份未变 → 只有追加，增量过滤新增尾部；否则重建。
  if (cached.sourceLength > 0 && source[cached.sourceLength - 1] !== cached.lastSourceElement) {
    return buildFull()
  }
  const added: Message[] = []
  for (let i = cached.sourceLength; i < source.length; i++) {
    if (isVisibleWindowMessage(source[i])) {
      added.push(source[i])
    }
  }
  const visible = added.length > 0 ? cached.visible.concat(added) : cached.visible
  visibleMessagesCache.set(state, {
    source,
    sourceLength: source.length,
    firstSourceElement: source[0],
    lastSourceElement: source[source.length - 1],
    visible
  })
  return visible
}

export function clearVisibleChatMessagesCache(state: ChatStoreState): void {
  visibleMessagesCache.delete(state)
}

// ==================== allMessageIndexBounds 增量缓存（M-3） ====================

/**
 * allMessageIndexBounds 增量缓存：与 getVisibleChatMessagesCached 同模式。
 *
 * allMessages 数组在会话内被原地 push / 尾元素替换（流式 replaceMessageAt），引用不变；
 * 因此以数组为 WeakMap 键，用（长度 + 首元素 + 尾元素）指纹校验：
 * - 指纹不匹配 / 长度收缩 / 首元素变化 → 全量重建；
 * - 长度不变且仅尾元素被替换（流式原地更新）→ 只重算尾元素索引；
 * - 长度增长且旧尾元素身份未变 → 只扫描新增尾部。
 * 中间位置同长度替换由 state.replaceMessageAt 的 L1 钩子（clearMessageIndexBoundsCache）兜底。
 */
interface IndexBoundsCacheEntry {
  length: number
  first: Message | undefined
  last: Message | undefined
  firstIndexed: number | null
  lastIndexed: number | null
  /** 尾元素（[0, length-1] 最后一条）是否带 backendIndex */
  lastWasIndexed: boolean
  /** [0, length-1) 内最后一条带 backendIndex 的消息索引（尾元素被替换为无索引消息时回退） */
  indexedBeforeTail: number | null
}

const indexBoundsCache = new WeakMap<Message[], IndexBoundsCacheEntry>()

function getMessageBackendIndex(message: Message | undefined): number | null {
  const bi = message?.backendIndex
  return typeof bi === 'number' && Number.isFinite(bi) ? bi : null
}

export interface AllMessageIndexBounds {
  firstIndexed: number | null
  lastIndexed: number | null
  nextFallbackIndex: number
}

export function getAllMessageIndexBoundsCached(
  messages: Message[],
  windowStartIndex: number
): AllMessageIndexBounds {
  const len = messages.length
  const cached = indexBoundsCache.get(messages)

  const buildFull = (): AllMessageIndexBounds => {
    let firstIndexed: number | null = null
    let lastIndexed: number | null = null
    let indexedBeforeTail: number | null = null
    for (let i = 0; i < len; i++) {
      const idx = getMessageBackendIndex(messages[i])
      if (idx === null) continue
      if (firstIndexed === null) firstIndexed = idx
      if (i < len - 1) indexedBeforeTail = idx
      lastIndexed = idx
    }
    indexBoundsCache.set(messages, {
      length: len,
      first: messages[0],
      last: messages[len - 1],
      firstIndexed,
      lastIndexed,
      lastWasIndexed: getMessageBackendIndex(messages[len - 1]) !== null,
      indexedBeforeTail
    })
    return { firstIndexed, lastIndexed, nextFallbackIndex: windowStartIndex + len }
  }

  if (!cached) return buildFull()

  // 指纹校验：收缩 / 首元素变化 / 未知结构性变更 → 全量重建
  if (len < cached.length || cached.first !== messages[0]) return buildFull()

  if (len === cached.length) {
    if (messages[len - 1] === cached.last) {
      // 完全未变（Vue 重复求值 / 非尾替换的已知空洞，由 L1 钩子兜底）：直接返回缓存
      return {
        firstIndexed: cached.firstIndexed,
        lastIndexed: cached.lastIndexed,
        nextFallbackIndex: windowStartIndex + len
      }
    }
    // 仅尾元素被替换（流式原地更新）：尾元素无索引时回退到 [0, len-1) 的最后索引
    const tailIdx = getMessageBackendIndex(messages[len - 1])
    const lastIndexed = tailIdx !== null ? tailIdx : cached.indexedBeforeTail
    indexBoundsCache.set(messages, {
      ...cached,
      last: messages[len - 1],
      lastIndexed,
      lastWasIndexed: tailIdx !== null
    })
    return { firstIndexed: cached.firstIndexed, lastIndexed, nextFallbackIndex: windowStartIndex + len }
  }

  // 长度增长：旧尾元素身份未变 → 纯尾部追加，只扫描新增尾部；否则重建
  if (cached.length > 0 && messages[cached.length - 1] !== cached.last) {
    return buildFull()
  }
  let lastIndexed = cached.lastIndexed
  for (let i = cached.length; i < len; i++) {
    const idx = getMessageBackendIndex(messages[i])
    if (idx !== null) lastIndexed = idx
  }
  const tailIdx = getMessageBackendIndex(messages[len - 1])
  indexBoundsCache.set(messages, {
    length: len,
    first: cached.first,
    last: messages[len - 1],
    firstIndexed: cached.firstIndexed,
    lastIndexed,
    lastWasIndexed: tailIdx !== null,
    indexedBeforeTail: cached.lastWasIndexed ? cached.lastIndexed : cached.indexedBeforeTail
  })
  return { firstIndexed: cached.firstIndexed, lastIndexed, nextFallbackIndex: windowStartIndex + len }
}

/** L1 钩子：中间位置同长度替换（指纹只校验首尾元素）时由 state.replaceMessageAt 调用清除缓存 */
export function clearMessageIndexBoundsCache(messages: Message[]): void {
  indexBoundsCache.delete(messages)
}

function getMessageAbsoluteIndex(message: Message | undefined, fallbackIndex: number): number {
  if (typeof message?.backendIndex === 'number' && Number.isFinite(message.backendIndex)) {
    return message.backendIndex
  }
  return fallbackIndex
}

function collectWindowRounds(messages: Message[]): WindowRound[] {
  const rounds: WindowRound[] = []
  let currentRoundStartIndex = -1
  let currentRoundVisibleCount = 0

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const isRoundStart = message.role === 'user' && !message.isFunctionResponse

    if (isRoundStart) {
      if (currentRoundStartIndex !== -1) {
        rounds.push({
          startIndex: currentRoundStartIndex,
          endIndex: i,
          visibleCount: currentRoundVisibleCount
        })
      }
      currentRoundStartIndex = i
      currentRoundVisibleCount = 0
    }

    if (currentRoundStartIndex !== -1 && isVisibleWindowMessage(message)) {
      currentRoundVisibleCount += 1
    }
  }

  if (currentRoundStartIndex !== -1) {
    rounds.push({
      startIndex: currentRoundStartIndex,
      endIndex: messages.length,
      visibleCount: currentRoundVisibleCount
    })
  }

  if (rounds.length === 0 && messages.length > 0) {
    rounds.push({
      startIndex: 0,
      endIndex: messages.length,
      visibleCount: messages.filter(isVisibleWindowMessage).length
    })
  }

  return rounds
}

export function calculateTrimWindowStartIndex(messages: Message[], maxVisibleCount = MAX_WINDOW_MESSAGES): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0

  const rounds = collectWindowRounds(messages)
  if (rounds.length === 0) {
    return getMessageAbsoluteIndex(messages[0], 0)
  }

  let keepStartIndex = rounds[rounds.length - 1].startIndex
  let keptVisibleCount = 0

  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]
    const nextVisibleCount = keptVisibleCount + round.visibleCount

    if (keptVisibleCount > 0 && nextVisibleCount > maxVisibleCount) {
      break
    }

    keepStartIndex = round.startIndex
    keptVisibleCount = nextVisibleCount
  }

  return getMessageAbsoluteIndex(messages[keepStartIndex], keepStartIndex)
}

/**
 * 用窗口推导并同步“已知总消息数”
 *
 * windowStartIndex 是绝对索引，因此 windowStartIndex + window.length 代表当前窗口覆盖到的末尾索引（近似总数）。
 */
export function syncTotalMessagesFromWindow(state: ChatStoreState): void {
  state.totalMessages.value = Math.max(state.totalMessages.value, state.windowStartIndex.value + state.allMessages.value.length)
}

/** 将 totalMessages 直接设置为当前窗口覆盖到的总数（用于 delete/回档等会减少历史长度的操作） */
export function setTotalMessagesFromWindow(state: ChatStoreState): void {
  state.totalMessages.value = Math.max(0, state.windowStartIndex.value + state.allMessages.value.length)
}

/**
 * 同步顶部折叠提示。
 *
 * foldedMessageCount 表示“当前窗口之前仍未加载的消息数”，应由窗口起点推导，
 * 不能按裁剪次数累加；否则用户上拉恢复历史后再次裁剪会让数字虚高。
 */
export function syncFoldedHistoryHint(state: ChatStoreState): void {
  if (state.windowStartIndex.value <= 0) {
    state.historyFolded.value = false
    state.foldedMessageCount.value = 0
    return
  }

  if (state.historyFolded.value) {
    state.foldedMessageCount.value = state.windowStartIndex.value
  }
}

/**
 * 裁剪消息窗口（从顶部丢弃更早消息）
 *
 * 返回：被丢弃的消息条数（包含 functionResponse）。
 */
export function trimWindowFromTop(state: ChatStoreState, maxCount = MAX_WINDOW_MESSAGES): number {
  const all = state.allMessages.value
  if (!Array.isArray(all) || all.length === 0) return 0

  const currentWindowStartIndex = getMessageAbsoluteIndex(all[0], state.windowStartIndex.value)
  const nextWindowStartIndex = calculateTrimWindowStartIndex(all, maxCount)
  if (nextWindowStartIndex <= currentWindowStartIndex) return 0

  let removeCount = 0
  while (removeCount < all.length) {
    const absoluteIndex = getMessageAbsoluteIndex(all[removeCount], currentWindowStartIndex + removeCount)
    if (absoluteIndex >= nextWindowStartIndex) {
      break
    }
    removeCount += 1
  }

  if (removeCount <= 0) return 0

  // M6 说明：窗口折叠只从顶部丢弃更早消息，而平滑条目（SmoothStreamer entry / smoothTexts）
  // 只存在于“当前正在流出的消息”——它总是窗口最后一条（占位消息最后追加、delta 只写它），
  // 不会被 trimWindowFromTop 丢弃，因此这里无需清理平滑层。
  // 若未来出现“流式消息被从顶部裁剪”的场景，需在此对移除 id 调 finishSmoothStream + smoothTexts.delete。
  replaceAllMessages(state, all.slice(removeCount))
  state.windowStartIndex.value = nextWindowStartIndex

  // L-7：不再裁剪窗口外的检查点。此前 filter 会永久丢弃 messageIndex < windowStartIndex 的检查点，
  // 用户上拉加载更早历史（windowStartIndex 前移）后这些检查点不会恢复，表现为存档条消失。
  // 保留全部检查点由 loadOlderMessagesPage / loadCheckpoints 负责与窗口对齐，内存占用受对话存档数约束。

  // 标记已发生折叠（用于 UI 提示）
  state.historyFolded.value = true
  syncFoldedHistoryHint(state)

  syncTotalMessagesFromWindow(state)

  perfLog('conversation.window.trim', {
    removed: removeCount,
    start: state.windowStartIndex.value,
    count: state.allMessages.value.length,
    total: state.totalMessages.value
  })

  return removeCount
}
