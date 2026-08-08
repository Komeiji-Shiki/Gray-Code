/**
 * 平滑流式输出器（SmoothStreamer）
 *
 * 原理：chunk 到达是突发的（一坨 50 token → 停 800ms → 再一坨），直接渲染就是
 * "喷一下、僵住、再喷"。SmoothStreamer 在显示层加一个恒定延迟的蓄水池：
 * chunk 进池，按自适应速率匀速放字——
 *
 *   每秒放字数 = clamp(积压字数 ÷ 前瞻窗口, 最小速率, 最大速率)
 *
 * 积压多自动加速（永远只落后真实流 ~lookahead），积压少减速细流；
 * 供应商卡顿时用户看到的是打字速度渐缓而不是冻结，视觉上把突发抹成匀速。
 *
 * 用途：真实内容（message.parts / content）照旧在 delta 到达时立即累加
 * （checkpoint、保存、复制、reroll 全用它），本类只驱动"显示层"文本的节奏，
 * 任何业务逻辑都不受污染。TPS 图等指标必须吃真实 chunk，不要接本显示层。
 *
 * commit 回调：每帧把放出的字素数组交给下游（CharFlow 等显示目标），
 * frameDurMs 用于批内亚帧错峰，instant=true 表示直通提交（panic 快进 /
 * flush，跳过淡入动画直接定型）。
 *
 * 兜底（webview 隐藏时 rAF 被浏览器节流）：
 * - dt 钳在 100ms：恢复后不会把整段停顿算进单帧
 * - 速率随积压自适应：积压越大放得越快
 * - panic 快进：积压超过阈值直接跳过部分，切回最多 ~lookahead 内追平
 */

export type SmoothMode = 'off' | 'smooth' | 'balanced' | 'silky'

/** 档位 → 前瞻窗口（显示层落后真实流的恒定延迟） */
export const SMOOTH_PRESETS: Record<Exclude<SmoothMode, 'off'>, { lookahead: number }> = {
  smooth: { lookahead: 220 }, // 灵敏
  balanced: { lookahead: 320 }, // 标准
  silky: { lookahead: 450 } // 丝滑
}

export interface SmoothStreamerOptions {
  /** 前瞻窗口（ms）：显示层落后真实流的恒定延迟 */
  lookahead?: number
  /** 最小每秒放字数（积压极小时的下限，避免停顿） */
  minCps?: number
  /** 最大每秒放字数（积压极大时的上限） */
  maxCps?: number
  /** 积压超过该长度直接快进（panic），防止长时间挂起后狂喷 */
  panic?: number
}

const DEFAULT_OPTIONS: Required<SmoothStreamerOptions> = {
  lookahead: 320,
  minCps: 25,
  maxCps: 1200,
  panic: 6000
}

/**
 * commit 回调：
 * @param graphemes  本帧放出的字素（显示目标按批错峰淡入）
 * @param frameDurMs 本帧时长（ms），批内错峰间隔的基准
 * @param instant    直通提交：panic 快进 / flush，跳过淡入直接定型
 */
export type SmoothCommit = (graphemes: string[], frameDurMs: number, instant: boolean) => void

// Intl.Segmenter 在部分运行时/TS lib 中缺失，这里做运行时探测 + 安全类型断言
interface SegmenterLike {
  segment: (input: string) => Iterable<{ segment: string }>
}
type SegmenterCtor = new (locale?: string | string[], options?: unknown) => SegmenterLike
const IntlWithSegmenter = Intl as unknown as { Segmenter?: SegmenterCtor }

const seg =
  typeof IntlWithSegmenter.Segmenter === 'function'
    ? new IntlWithSegmenter.Segmenter(undefined, { granularity: 'grapheme' })
    : null

export class SmoothStreamer {
  private queue: string[] = []
  private raf = 0
  private last = 0
  private carry = 0

  constructor(
    private readonly commit: SmoothCommit,
    options?: SmoothStreamerOptions
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options }
  }

  private readonly opts: Required<SmoothStreamerOptions>

  /** 收到一段流式增量文本（真实内容已由调用方累加，这里只进显示池） */
  push(chunk: string): void {
    if (!chunk) return
    const graphemes = seg
      ? Array.from(seg.segment(chunk), item => item.segment)
      : Array.from(chunk)
    for (const grapheme of graphemes) this.queue.push(grapheme)

    // queue 与 panic 都以字素为单位，避免 emoji 等代理对按 UTF-16 码元预判后被过早直通。
    if (this.queue.length > this.opts.panic) {
      this.emitDirect(this.queue.splice(0, this.queue.length - this.opts.panic).join(''))
    }
    this.loop()
  }

  /** 立即把积压全部输出（中止/切分支/终结用，不丢尾巴） */
  flush(): void {
    if (this.queue.length) {
      this.emitDirect(this.queue.splice(0).join(''))
    }
    this.stop()
  }

  /** 段落切换：上一段积压立即输出，然后清空蓄水池开始新段落 */
  switchPart(): void {
    this.flush()
    this.stop()
    this.queue = []
    this.carry = 0
  }

  /** 销毁（不再使用后调用） */
  dispose(): void {
    this.stop()
    this.queue = []
  }

  /** 直通提交：整个增量一次给出，不做字素错峰（panic / flush） */
  private emitDirect(text: string): void {
    if (!text) return
    this.commit(Array.from(text), 0, true)
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private loop(): void {
    if (this.raf || !this.queue.length) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (t: number): void => {
    this.raf = 0
    // dt 钳在 100ms：webview 隐藏时 rAF 节流，恢复后不会把停顿算进单帧
    const dt = Math.min(t - this.last, 100)
    this.last = t
    const cps = Math.min(
      this.opts.maxCps,
      Math.max(this.opts.minCps, this.queue.length / (this.opts.lookahead / 1000))
    )
    this.carry += (cps * dt) / 1000
    const n = Math.floor(this.carry)
    if (n > 0 && this.queue.length) {
      this.carry -= n
      const graphemes = this.queue.splice(0, n)
      if (graphemes.length) this.commit(graphemes, dt, false)
    }
    if (this.queue.length) {
      this.raf = requestAnimationFrame(this.tick)
    }
  }
}
