/**
 * 前端实时 TPS（tokens per second）采样器（模块级单例）。
 *
 * 数据流：
 * - 流式 chunk 到达时（stores/chat/streamChunkHandlers.ts）调用 record(tokenCount[, timestamp])
 *   注入真实 token 到达；
 * - 内部 200ms 定时采样：1s 滑动窗口累计 token 数 → 瞬时速率（硬上限 MAX_RATE）→ EMA(α=0.3) 平滑；
 * - 定长 ring（30 点 ≈ 6s 历史）随采样滚动；
 * - UI（components/input/TpsBar.vue）通过 subscribe 订阅 { ema, ring, live } 绘制柱状图。
 *
 * 突发摊薄：单次 record 超过 MAX_SINGLE_EVENT_TOKENS 时拆分为多个小事件，时间均匀分布在
 * [t - BURST_SPREAD_MS, t]，总量守恒——避免单个大事件（如 OpenAI Responses 的 finalArgs 整块
 * 到达、超长单 chunk）在 1s 窗口内制造单点尖峰；配合 sample() 的 MAX_RATE 硬上限，
 * 突发/积压不会把瞬时速率抬到异常值。
 *
 * 时间戳参数：record(tokenCount, timestamp?) 缺省用接收时刻；显式传入 chunk.createdAt 时事件按
 * 原始发生时间入窗——后台标签页缓冲回放 / 隐藏 webview 积压的数据会因时间戳落在窗口外而被
 * 立即修剪，这正是期望行为（积压不参与实时 TPS）。live 判定始终基于真实接收时刻（调用时刻）。
 *
 * live 判定：最近 2s 内有过真实 record 调用。流结束/空闲后 EMA 自然指数衰减，
 * 衰减到不可见阈值（SETTLE_EPS）以下即精确归零，由 UI 展示为 0 与空画布；
 * 不注入任何模拟数据。
 *
 * 内存有界：record 事件缓冲有容量上限（MAX_EVENTS，突发摊薄后按小事件个数计），
 * 即使无订阅（webview 隐藏/后台流）导致停表不采样，缓冲也不会无界增长；
 * stop() 清空全部状态，避免重挂载读到过期的 live/曲线数据。
 */

export type TpsSource = 'tokenizer' | 'estimate'

export interface TpsSample {
  /** EMA 平滑后的当前瞬时速率（tok/s） */
  ema: number
  /** 定长历史（最近 N 次采样），随采样滚动 */
  ring: number[]
  /** 最近 2s 内是否收到过真实 token 到达 */
  live: boolean
  /** 最近一次 record 的 token 计数来源；无来源信息（旧调用/从未记录）时为 null */
  source: TpsSource | null
}

const SAMPLE_MS = 200
const WINDOW_MS = 1000
const EMA_ALPHA = 0.3
const LIVE_WINDOW_MS = 2000
const RING_SIZE = 30
/** record 事件缓冲容量上限：超限丢最旧，保证任意场景下 events 有界（摊薄后按小事件个数计） */
const MAX_EVENTS = 1000
/** 自然归零阈值（tok/s）：无事件到达且 EMA 衰减到该值以下时精确归零，
 * 让 UI 能稳定判定"已归零"（浮点指数衰减永远不会精确到 0）。 */
const SETTLE_EPS = 0.05
/** 突发摊薄阈值：单次 record 的 token 数超过该值时拆分为多个小事件，避免单点尖峰 */
const MAX_SINGLE_EVENT_TOKENS = 250
/** 突发摊薄时间跨度（毫秒）：拆分后的小事件时间均匀分布在 [t - BURST_SPREAD_MS, t] */
const BURST_SPREAD_MS = 1000
/** 采样速率硬上限（tok/s）：即使 1s 窗口内有突发，单次采样速率也不超过该值 */
const MAX_RATE = 1200

class TpsMeter {
  private events: { t: number; n: number }[] = []
  private ema = 0
  private ring: number[] = []
  private timer: number | null = null
  private listeners = new Set<(sample: TpsSample) => void>()
  private lastRecordAt = 0
  private lastSource: TpsSource | null = null
  private lastSample: TpsSample = { ema: 0, ring: [], live: false, source: null }

  /**
   * 流式回调每收到一个 chunk 调用一次。
   * tokenCount 为该 chunk 携带的 token 数（供应商无逐 chunk usage 时按文本长度估算）。
   * timestamp 为事件真实发生时间（如 chunk.createdAt），缺省用接收时刻。
   * source 为 token 计数来源（真实 tokenizer / 字符估算），供 UI 区分显示；缺省不更新。
   *
   * 注意：传入"过去的时间戳"（回放/积压场景）时，事件会立刻被窗口修剪掉——
   * 这正是期望行为，积压数据不参与实时 TPS。
   */
  record(tokenCount: number, timestamp?: number, source?: TpsSource): void {
    if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) return
    const now = Date.now()
    // live 判定用真实接收时刻（调用时刻），与事件时间戳无关
    this.lastRecordAt = now
    if (source === 'tokenizer' || source === 'estimate') this.lastSource = source
    const t = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : now

    // 突发摊薄：单事件 > MAX_SINGLE_EVENT_TOKENS 时拆成 k = ceil(n/250) 个小事件，
    // 时间均匀分布在 [t - BURST_SPREAD_MS, t]（最后一个小事件落在 t），
    // 每个小事件 ceil(n/k)，末事件携带余数 → 总量精确守恒
    if (tokenCount > MAX_SINGLE_EVENT_TOKENS) {
      const k = Math.ceil(tokenCount / MAX_SINGLE_EVENT_TOKENS)
      const perEvent = Math.ceil(tokenCount / k)
      for (let i = 0; i < k; i++) {
        const spread = k > 1 ? Math.round((BURST_SPREAD_MS * i) / (k - 1)) : 0
        const n = i === k - 1 ? tokenCount - perEvent * (k - 1) : perEvent
        this.pushEvent({ t: t - BURST_SPREAD_MS + spread, n })
      }
    } else {
      this.pushEvent({ t, n: tokenCount })
    }
  }

  /** 入队单个事件并维持容量上限（摊薄后事件更多，上限检查在 push 时做） */
  private pushEvent(event: { t: number; n: number }): void {
    this.events.push(event)
    // 容量上限：超限丢最旧（O(1) 均摊），保证 events 始终有界
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = window.setInterval(() => this.sample(), SAMPLE_MS)
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    // 停表后清空状态：避免重挂载时读到过期的 live/曲线数据（最后一次采样可能仍在
    // 2s live 窗口内）。EMA/ring/source 一并清零，让下一次会话从干净状态起步。
    this.events = []
    this.lastRecordAt = 0
    this.lastSource = null
    this.ema = 0
    this.ring = []
    this.lastSample = { ema: 0, ring: [], live: false, source: null }
  }

  /** 订阅采样；返回取消订阅函数（最后一个订阅者取消后自动停止定时器） */
  subscribe(cb: (sample: TpsSample) => void): () => void {
    this.listeners.add(cb)
    // 订阅时事件缓冲为空 → 强制 live=false，兜底避免显示过期 live 快照
    if (this.events.length === 0) {
      this.lastSample = { ...this.lastSample, live: false }
    }
    this.start()
    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** 最近一次采样快照（组件挂载时立即有一帧可用） */
  get snapshot(): TpsSample {
    return this.lastSample
  }

  private sample(): void {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    while (this.events.length > 0 && this.events[0].t < cutoff) {
      this.events.shift()
    }
    const total = this.events.reduce((sum, e) => sum + e.n, 0)
    // 速率硬上限：突发即使被摊薄也可能让窗口瞬时偏高，MAX_RATE 兜底防止异常尖峰
    const rate = Math.min(total / (WINDOW_MS / 1000), MAX_RATE)
    let ema = this.ema === 0 ? rate : this.ema * (1 - EMA_ALPHA) + rate * EMA_ALPHA
    // 自然归零：无 token 到达时 EMA 指数衰减，衰减到不可见阈值以下即精确归零
    if (rate === 0 && ema < SETTLE_EPS) ema = 0
    this.ema = ema
    this.ring.push(this.ema)
    if (this.ring.length > RING_SIZE) this.ring.shift()
    this.lastSample = {
      ema: this.ema,
      ring: this.ring.slice(),
      live: now - this.lastRecordAt <= LIVE_WINDOW_MS,
      source: this.lastSource
    }
    for (const cb of this.listeners) cb(this.lastSample)
  }
}

/** 全局单例：跨组件共享同一份真实流数据（多标签页并发流各自 record，采样统一汇总） */
export const tpsMeter = new TpsMeter()
