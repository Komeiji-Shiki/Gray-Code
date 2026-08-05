/**
 * 前端实时 TPS（tokens per second）采样器（模块级单例）。
 *
 * 数据流：
 * - 流式 chunk 到达时（stores/chat/streamChunkHandlers.ts）调用 record(tokenCount) 注入真实 token 到达；
 * - 内部 200ms 定时采样：1s 滑动窗口累计 token 数 → 瞬时速率 → EMA(α=0.3) 平滑；
 * - 定长 ring（30 点 ≈ 6s 历史）随采样滚动；
 * - UI（components/input/TpsBar.vue）通过 subscribe 订阅 { ema, ring, live } 绘制柱状图。
 *
 * live 判定：最近 2s 内有过真实 record 调用。无真实流（开始动画/空闲等待）时
 * UI 自行用随机模拟波动，让启动与空闲阶段的图表保持活性。
 */

export interface TpsSample {
  /** EMA 平滑后的当前瞬时速率（tok/s） */
  ema: number
  /** 定长历史（最近 N 次采样），随采样滚动 */
  ring: number[]
  /** 最近 2s 内是否收到过真实 token 到达 */
  live: boolean
}

const SAMPLE_MS = 200
const WINDOW_MS = 1000
const EMA_ALPHA = 0.3
const LIVE_WINDOW_MS = 2000
const RING_SIZE = 30

class TpsMeter {
  private events: { t: number; n: number }[] = []
  private ema = 0
  private ring: number[] = []
  private timer: number | null = null
  private listeners = new Set<(sample: TpsSample) => void>()
  private lastRecordAt = 0
  private lastSample: TpsSample = { ema: 0, ring: [], live: false }

  /**
   * 流式回调每收到一个 chunk 调用一次。
   * tokenCount 为该 chunk 携带的 token 数（供应商无逐 chunk usage 时按文本长度估算）。
   */
  record(tokenCount: number): void {
    if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) return
    const now = Date.now()
    this.lastRecordAt = now
    this.events.push({ t: now, n: tokenCount })
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
  }

  /** 订阅采样；返回取消订阅函数（最后一个订阅者取消后自动停止定时器） */
  subscribe(cb: (sample: TpsSample) => void): () => void {
    this.listeners.add(cb)
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
    const rate = total / (WINDOW_MS / 1000)
    this.ema = this.ema === 0 ? rate : this.ema * (1 - EMA_ALPHA) + rate * EMA_ALPHA
    this.ring.push(this.ema)
    if (this.ring.length > RING_SIZE) this.ring.shift()
    this.lastSample = {
      ema: this.ema,
      ring: this.ring.slice(),
      live: now - this.lastRecordAt <= LIVE_WINDOW_MS
    }
    for (const cb of this.listeners) cb(this.lastSample)
  }
}

/** 全局单例：跨组件共享同一份真实流数据（多标签页并发流各自 record，采样统一汇总） */
export const tpsMeter = new TpsMeter()
