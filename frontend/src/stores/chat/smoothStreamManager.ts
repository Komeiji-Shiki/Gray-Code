/**
 * 平滑流式输出的实例管理（模块级单例）。
 *
 * 每条流式消息一个 SmoothStreamer 实例（Map<messageId, entry>），
 * 多标签页 / subagent 并发流互不干扰。partKey 表达"当前正在输出的段落身份"
 * （thought/text + part 索引），段落切换（thought → 正文、工具调用后新正文）时
 * 先放完上一段积压再重置蓄水池，新段落从空开始平滑打出。
 *
 * 真实内容（message.parts / content）由 streamChunkHandlers 照旧累加；
 * 本模块只负责驱动"显示层"文本的节奏。TPS 等指标吃真实 chunk，不经此层。
 *
 * 显示层（CharFlow）：
 * - MessageItem 挂载活动尾块 host 时通过 registerSmoothDisplay 注册；
 *   SmoothStreamer 每帧 commit 的字素由 manager 高频直连 CharFlow.append
 *   （手动 DOM，完全绕过 Vue 响应式——每秒几十上百次的 DOM 增量不值得走
 *   vnode diff）。
 * - smoothTexts 快照降级为低频（~120ms 一次，段落切换/终结强制），仅用于
 *   组件重建恢复（切标签页/虚拟列表卸载后 restore 累计文本）与 UI 判定。
 *
 * 显示基线（H3）：entry 记录 baseText（创建/段落切换时该 part 已累计的真实文本，
 * 不含后续 delta）。restore/快照文本 = baseText + committed（已提交 delta 累计），
 * 保证平滑显示与已渲染真实内容连续——档位 off→on 或切标签页回来重建实例时
 * 不会出现"已渲染内容消失重打"的跳变。
 */

import {
  SmoothStreamer,
  SMOOTH_PRESETS,
  type SmoothMode,
  type SmoothStreamerOptions
} from '../../utils/smoothStream'
import { CharFlow } from '../../utils/charFlow'

interface SmoothEntry {
  /** 消息 id（随 migrate 更新，commit 回调据此查显示目标） */
  messageId: string
  streamer: SmoothStreamer
  partKey: string
  mode: SmoothMode
  /** 当前 part 的显示基线：创建/段落切换时的累计真实文本（不含后续 delta） */
  baseText: string
  /** 已提交（显示层可见）的 delta 累计，displayText = baseText + committed */
  committed: string
  /** 已提升（promote）给渐进 markdown 层的文本：CharFlow 当前显示 = baseText + committed - promotedText */
  promotedText: string
  /** 上次快照时间（performance.now）；null 表示尚未生成首帧快照 */
  lastSnapshotAt: number | null
  /** 上次快照的显示文本；null 允许首帧显式发布空基线 */
  lastSnapshotText: string | null
  /** 上次快照对应的 partKey；文本相同但段落变化时仍须发布 */
  lastSnapshotPartKey: string | null
  /** 快照回调：写入 store.smoothTexts（低频节流，由本模块控制频率） */
  onSnapshot: (messageId: string, partKey: string, displayText: string) => void
}

interface SmoothDisplay {
  host: HTMLElement
  flow: CharFlow
  followEnd: boolean
  noFade: boolean
  squashLineBreaks: boolean
  tailWindow?: number
  restoreFull: boolean
  /** 垂直滚动容器：多行预览贴底写在容器上（host 自身不滚动） */
  scrollContainer?: HTMLElement
  /** 内容更新时是否应贴底（用户向上查看时返回 false 停止打扰） */
  stickBottom?: () => boolean
  /** 尾部窗口首次裁剪时回调（中展开裁剪提示） */
  onTrimmed?: () => void
  /** 渐进 markdown：已定型文本到达安全段落边界时回调提升的文本 */
  onPromote?: (text: string) => void
}

export interface SmoothDisplayOptions {
  /** 单行预览宿主是否应始终滚动到最新字符 */
  followEnd?: boolean
  /** 禁用错峰淡入（直接文本追加）。折叠预览等不适合逐字动画的场景用——
   * 动画 delay 期间的透明占位字符会把 followEnd 滚动目标挤成空白 */
  noFade?: boolean
  /** 把换行符折叠为零宽空格（\u200B）：nowrap 单行预览中换行渲染成占位空格，
   * 会把最新字符挤成空白；零宽后滚动目标始终是真实可见字符 */
  squashLineBreaks?: boolean
  /** 尾部窗口：只保留最近 N 个字符（折叠预览内容有界，防长思考撑爆单行容器） */
  tailWindow?: number
  /** 注册时恢复完整累计文本（不裁剪已提升部分）。折叠预览无渐进渲染层，
   * 需要显示完整内容流；展开态（有 onPromote）恢复未提升尾巴 + 重放提升文本 */
  restoreFull?: boolean
  /** 垂直滚动容器：多行预览贴底写在容器上（host 自身不滚动） */
  scrollContainer?: HTMLElement
  /** 内容更新时是否应贴底（用户向上查看时返回 false 停止打扰） */
  stickBottom?: () => boolean
  /** 尾部窗口首次裁剪时回调（中展开裁剪提示） */
  onTrimmed?: () => void
  /** 渐进 markdown：已定型文本到达安全段落边界（\n\n + fence 配对）时回调提升的文本。
   * 正文尾块与展开的思考块启用；折叠预览不启用 */
  onPromote?: (text: string) => void
}

const entries = new Map<string, SmoothEntry>()
/** 显示目标注册表：messageId → 当前挂载的 CharFlow 宿主 */
const displays = new Map<string, SmoothDisplay>()
/** 反向索引：CharFlow 宿主 → messageId。消息 id 迁移后 unregister 按宿主定位新键时
 *  无需 O(n) 全表扫描（原实现 Array.from(displays.entries()).find(...)） */
const hostToMessageId = new Map<HTMLElement, string>()

/** smoothTexts 快照的最小间隔（ms）：组件判定/恢复用，不需要跟随每帧动画 */
const SNAPSHOT_INTERVAL_MS = 120

/**
 * 找最后一个安全的渐进渲染边界：以 \n\n 结尾、且该点之前行首 fence（```/~~~）配对。
 * fence 未配对时向前回退到更早的空行边界；找不到则返回 0（不提升，等段落完成）。
 */
function findPromoteCut(text: string): number {
  if (text.length < 4) return 0
  let idx = text.lastIndexOf('\n\n')
  while (idx > 0) {
    const cut = idx + 2
    if (!hasUnclosedFence(text.slice(0, cut))) return cut
    idx = text.lastIndexOf('\n\n', idx - 1)
  }
  return 0
}

/** 行首 fence（``` / ~~~）是否未配对：未配对时不能提升（半截代码块渲染会崩坏） */
function hasUnclosedFence(text: string): boolean {
  let count = 0
  for (const line of text.split('\n')) {
    const t = line.trimStart()
    if (t.startsWith('```') || t.startsWith('~~~')) count++
  }
  return count % 2 === 1
}

/**
 * 渐进 markdown 提升：已定型文本到达安全段落边界时，把该前缀从 CharFlow 剥离并回调给宿主
 * （MessageItem 累加进渐进 MarkdownRenderer 即时渲染）。每帧 commit 后调用一次；
 * settled 通常只有「未完成段落 + 已定型字符」，无 \n\n 时 lastIndexOf 立即返回，扫描成本可控。
 */
function maybePromote(entry: SmoothEntry): void {
  const display = displays.get(entry.messageId)
  if (!display || typeof display.onPromote !== 'function') return
  const cut = findPromoteCut(display.flow.settledText)
  if (cut <= 0) return
  const promoted = display.flow.promote(cut)
  if (!promoted) return
  entry.promotedText += promoted
  display.onPromote(promoted)
}

function buildOptions(mode: SmoothMode): SmoothStreamerOptions {
  const preset = mode === 'off' ? undefined : SMOOTH_PRESETS[mode]
  return preset ? { lookahead: preset.lookahead } : {}
}

/**
 * 注册某消息的显示目标。相同宿主重复注册是幂等操作，低频 smoothTexts 快照
 * 不会反复销毁并重建 CharFlow。
 */
export function registerSmoothDisplay(
  messageId: string,
  host: HTMLElement,
  options: SmoothDisplayOptions = {}
): void {
  const followEnd = options.followEnd === true
  const noFade = options.noFade === true
  const squashLineBreaks = options.squashLineBreaks === true
  const tailWindow = options.tailWindow !== undefined && options.tailWindow > 0 ? options.tailWindow : undefined
  const restoreFull = options.restoreFull === true
  const scrollContainer = options.scrollContainer
  const stickBottom = options.stickBottom
  const onTrimmed = options.onTrimmed
  const onPromote = options.onPromote
  const existing = displays.get(messageId)
  if (
    existing?.host === host &&
    existing.followEnd === followEnd &&
    existing.noFade === noFade &&
    existing.squashLineBreaks === squashLineBreaks &&
    existing.tailWindow === tailWindow &&
    existing.restoreFull === restoreFull &&
    existing.scrollContainer === scrollContainer &&
    existing.stickBottom === stickBottom &&
    existing.onTrimmed === onTrimmed &&
    existing.onPromote === onPromote
  ) {
    return
  }
  if (existing) {
    existing.flow.dispose()
    hostToMessageId.delete(existing.host)
    displays.delete(messageId)
  }

  const flow = new CharFlow(host, {
    fadeMs: 110,
    noFade,
    followEnd,
    squashLineBreaks,
    tailWindow,
    scrollContainer,
    stickBottom,
    onTrimmed
  })
  const entry = entries.get(messageId)
  if (entry) {
    // 渐进渲染：已提升部分不重复显示（由 onPromote 重放交给 markdown 层），
    // CharFlow 只恢复未提升的尾巴，保证组件重建（切标签页/虚拟列表）后显示连续。
    // 折叠预览（restoreFull）没有渐进渲染层，恢复完整累计文本供单行滚动预览。
    const fullText = entry.baseText + entry.committed
    flow.restore(restoreFull ? fullText : fullText.slice(entry.promotedText.length))
    if (entry.promotedText && onPromote) {
      onPromote(entry.promotedText)
    }
  }
  displays.set(messageId, { host, flow, followEnd, noFade, squashLineBreaks, tailWindow, restoreFull, scrollContainer, stickBottom, onTrimmed, onPromote })
  hostToMessageId.set(host, messageId)
  if (entry && onPromote) {
    // 注册后立即尝试提升已定型完整段落：展开/重建后不用等下一个字符才出格式
    maybePromote(entry)
  }
}

/**
 * 注销显示目标。传入宿主时只注销该宿主拥有的注册，避免 thought → text
 * 切换期间旧组件的卸载回调误删刚挂载的新宿主。消息 id 迁移后会按宿主定位新键。
 */
export function unregisterSmoothDisplay(messageId: string, host?: HTMLElement | null): void {
  let key = messageId
  let existing = displays.get(key)

  if (host && existing?.host !== host) {
    // 消息 id 迁移后按宿主定位新键（hostToMessageId 反向索引，O(1)）
    const relocatedKey = hostToMessageId.get(host)
    if (relocatedKey === undefined) return
    key = relocatedKey
    existing = displays.get(key)
  }

  if (!existing || (host && existing.host !== host)) return
  existing.flow.dispose()
  displays.delete(key)
  hostToMessageId.delete(existing.host)
}

/**
 * 推送一段流式增量文本到平滑蓄水池。
 *
 * @param messageId 流式消息 ID（每条消息一个实例）
 * @param partKey   当前段落身份；变化时先放完上一段积压再重置
 * @param text      本次 chunk 的增量文本（非累计值）
 * @param mode      平滑档位（'off' 时调用方不应进入本函数）
 * @param baseText  当前 part 已累计的真实文本（不含本次 delta），作为显示基线
 * @param onSnapshot 低频快照回调（partKey, 累计显示文本），写入 store.smoothTexts
 */
export function pushSmoothText(
  messageId: string,
  partKey: string,
  text: string,
  mode: SmoothMode,
  baseText: string,
  onSnapshot: (messageId: string, partKey: string, displayText: string) => void
): void {
  let entry = entries.get(messageId)
  if (!entry || entry.mode !== mode) {
    // 档位重建：旧实例先放完积压；promote 边界（promotedText）继承给新实例，
    // 使 CharFlow 尾巴与宿主渐进 markdown（tailRendered）保持连续，不重复不丢失。
    let inheritedPromoted = ''
    if (entry) {
      entry.streamer.flush()
      maybeSnapshot(entry, true)
      inheritedPromoted = entry.promotedText
      entry.streamer.dispose()
      entries.delete(messageId)
    }
    // 档位重建：显示目标切到新基线（真实文本），不丢已显示内容
    const display = displays.get(messageId)
    if (display) {
      display.flow.restore(baseText.slice(inheritedPromoted.length))
    }
    // 先建 entry 再建 streamer：commit 回调需要引用 entry（按引用读取，切换/迁移后仍取当前值）
    const created: SmoothEntry = {
      messageId,
      streamer: undefined as unknown as SmoothStreamer,
      partKey,
      mode,
      baseText,
      committed: '',
      promotedText: inheritedPromoted,
      lastSnapshotAt: null,
      lastSnapshotText: null,
      lastSnapshotPartKey: null,
      onSnapshot
    }
    created.streamer = new SmoothStreamer(
      (graphemes, frameDurMs, instant) => {
        created.committed += graphemes.join('')
        const target = displays.get(created.messageId)
        if (target) {
          target.flow.append(graphemes, frameDurMs, instant)
          maybePromote(created)
        }
        maybeSnapshot(created)
      },
      buildOptions(mode)
    )
    entries.set(messageId, created)
    entry = created
    // 首个 delta 入队前先发布当前基线（即使为空），让 Vue 在首个 rAF commit 前挂载 host。
    maybeSnapshot(created, true)
  }

  if (entry.partKey !== partKey) {
    // 段落切换：switchPart 内部先 flush 上一段积压（此时 entry 仍是旧 partKey/baseText，
    // flush 提交按旧基线计算）；随后注销旧显示目标（旧段落由 renderBlocks 接管为稳定块），
    // 并把基线切到新段落（新 part 的累计真实文本或 ''）。MessageItem 感知 partKey 变化后
    // 会重新注册显示目标并 restore 新基线。
    entry.streamer.switchPart()
    // switchPart 的 flush 可能落在 120ms 节流窗口内；重置 part 身份前强制保存旧段最终快照。
    maybeSnapshot(entry, true)
    const oldDisplay = displays.get(messageId)
    if (oldDisplay) {
      oldDisplay.flow.finish()
      oldDisplay.flow.dispose()
      displays.delete(messageId)
    }
    entry.baseText = baseText
    entry.committed = ''
    entry.promotedText = ''
    entry.partKey = partKey
    maybeSnapshot(entry, true)
  }
  entry.streamer.push(text)
}

/** 低频快照：内容未变化不重复写；节流写 smoothTexts；段落切换/终结时 force 强制立即写。 */
function maybeSnapshot(entry: SmoothEntry, force = false): void {
  const now = performance.now()
  const text = entry.baseText + entry.committed
  if (entry.lastSnapshotText === text && entry.lastSnapshotPartKey === entry.partKey) return
  if (!force && entry.lastSnapshotAt !== null && now - entry.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return
  entry.lastSnapshotAt = now
  entry.lastSnapshotText = text
  entry.lastSnapshotPartKey = entry.partKey
  entry.onSnapshot(entry.messageId, entry.partKey, text)
}

/**
 * 终结清理：先放完积压（不丢尾巴）、定型显示层并强制快照，再销毁实例。
 * 显示目标只 finish（内容保留到 UI 切回真实 content），随后由宿主组件调用
 * unregisterSmoothDisplay 释放。调用方还应从 store.smoothTexts 删除该消息的显示文本。
 */
export function finishSmoothStream(messageId: string): void {
  const entry = entries.get(messageId)
  if (entry) {
    entry.streamer.flush()
    // 终结强制快照：flush 尾巴必须落进 smoothTexts（UI 切回真实 content 前的最后显示）
    maybeSnapshot(entry, true)
    entry.streamer.dispose()
    entries.delete(messageId)
  }
  const display = displays.get(messageId)
  if (display) {
    display.flow.finish()
  }
}

/**
 * 消息 id 迁移（占位 id → 后端持久化 id）：同步重命名 manager entry 与
 * 显示目标键，避免后续按新 id 终结清理时旧条目残留（H1）。
 */
export function migrateSmoothStream(fromId: string, toId: string): void {
  if (fromId === toId) return
  const entry = entries.get(fromId)
  if (entry) {
    entry.messageId = toId
    entries.delete(fromId)
    entries.set(toId, entry)
  }
  const display = displays.get(fromId)
  if (display !== undefined) {
    displays.delete(fromId)
    displays.set(toId, display)
    hostToMessageId.set(display.host, toId)
  }
}

/** 全量清理（会话切换/应用销毁等兜底） */
export function disposeAllSmoothStreams(): void {
  for (const entry of entries.values()) {
    entry.streamer.dispose()
  }
  entries.clear()
  for (const display of displays.values()) {
    display.flow.dispose()
  }
  displays.clear()
  hostToMessageId.clear()
}

/** 当前是否有该消息的活跃平滑实例（供测试/诊断） */
export function hasSmoothStream(messageId: string): boolean {
  return entries.has(messageId)
}
