/**
 * tpsMeter 单元测试（fake timers + fake Date）
 *
 * 覆盖：
 * - 窗口累计：1s 滑动窗口内 token 求和 → 瞬时速率（total / 1s）
 * - 1s 修剪：过期事件不再计入窗口
 * - EMA 平滑：首次=瞬时速率，之后 ema = ema×0.7 + rate×0.3
 * - ring 定长：超过 30 点只保留最近 30 点
 * - live 判定：2s 内有真实 record → true，超过 2s → false
 * - events 容量上限：超过 1000 条丢最旧，缓冲有界（无订阅停表时也不无界增长）
 * - 退订停表：最后一个订阅者取消后停止采样
 * - 停表状态清理：快照 live 强制 false、无过期曲线
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tpsMeter, type TpsSample } from '../../utils/tpsMeter'

const unsubs: (() => void)[] = []

function subscribe(cb: (sample: TpsSample) => void): () => void {
  const un = tpsMeter.subscribe(cb)
  unsubs.push(un)
  return un
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  // 逐个退订（最后一个退订会 stop() 并清空状态，保证用例间隔离）
  for (const un of unsubs) un()
  unsubs.length = 0
  vi.useRealTimers()
})

describe('采样窗口与速率', () => {
  it('1s 窗口累计 token → 瞬时速率（total / 1s）', () => {
    tpsMeter.record(40)
    tpsMeter.record(60)
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    vi.advanceTimersByTime(200)

    expect(samples).toHaveLength(1)
    expect(samples[0].ema).toBeCloseTo(100, 5)
    expect(samples[0].ring).toHaveLength(1)
    expect(samples[0].ring[0]).toBeCloseTo(100, 5)
    expect(samples[0].live).toBe(true)
  })

  it('1s 窗口修剪：过期事件不再计入', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(300) // t=0
    vi.advanceTimersByTime(1000) // 采样 @200..1000；@1000 时 record@0 仍在窗口内
    tpsMeter.record(300) // t=1000
    vi.advanceTimersByTime(200) // 采样 @1200：record@0 已过期被修剪 → total=300

    const last = samples[samples.length - 1]
    // 若未修剪：total=600 → 速率 600，ema 会显著高于 300
    expect(last.ema).toBeCloseTo(300, 5)
    expect(last.ema).toBeLessThan(400)
  })

  it('EMA 平滑：首次=瞬时速率，之后 ema = ema×0.7 + rate×0.3', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(100) // t=0
    vi.advanceTimersByTime(200) // @200: total=100 → rate=100 → ema=100（首次）
    expect(samples[0].ema).toBeCloseTo(100, 5)

    tpsMeter.record(100) // t=200
    vi.advanceTimersByTime(200) // @400: total=200 → rate=200 → ema=100×0.7+200×0.3=130
    expect(samples[1].ema).toBeCloseTo(130, 5)

    vi.advanceTimersByTime(200) // @600: total 仍=200（两笔都在窗口内）→ ema=130×0.7+60=151
    expect(samples[2].ema).toBeCloseTo(151, 5)
  })

  it('ring 定长：超过 30 点只保留最近 30 点', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(10)
    for (let i = 0; i < 40; i++) vi.advanceTimersByTime(200)

    expect(samples).toHaveLength(40)
    expect(samples[19].ring).toHaveLength(20)
    expect(samples[39].ring).toHaveLength(30)
    // ring 末尾为最近一次采样值
    expect(samples[39].ring[samples[39].ring.length - 1]).toBeCloseTo(samples[39].ema, 5)
  })
})

describe('live 判定', () => {
  it('2s 内有真实 record → live=true，超过 2s → live=false', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(10) // t=0
    vi.advanceTimersByTime(1000) // 距最后 record 1000ms → live
    expect(samples[samples.length - 1].live).toBe(true)

    tpsMeter.record(10) // t=1000 刷新
    vi.advanceTimersByTime(1900) // 距最后 record 1900ms → live
    expect(samples[samples.length - 1].live).toBe(true)

    vi.advanceTimersByTime(400) // 采样 @2000ms（边界仍 live）与 @2200ms → 不 live
    expect(samples[samples.length - 1].live).toBe(false)
  })
})

describe('events 容量上限', () => {
  it('无订阅（停表）时 record 超 1000 条仍受控：丢最旧', () => {
    // 停表状态（无订阅）：事件缓冲不应无界增长
    for (let i = 0; i < 1100; i++) tpsMeter.record(1)

    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))
    vi.advanceTimersByTime(200)

    // 只保留最近 1000 条 → 窗口 total=1000 → 速率 1000（若未裁剪应为 1100）
    expect(samples[0].ema).toBeCloseTo(1000, 5)
  })
})

describe('退订与状态清理', () => {
  it('最后一个订阅者取消后停表：不再采样', () => {
    const samples: TpsSample[] = []
    const un = subscribe((s) => samples.push(s))

    vi.advanceTimersByTime(200)
    expect(samples).toHaveLength(1)

    un()
    const count = samples.length
    vi.advanceTimersByTime(2000)
    expect(samples).toHaveLength(count)
  })

  it('停表后状态清理：快照 live 强制 false、无过期曲线', () => {
    const un = subscribe(() => {})
    tpsMeter.record(10)
    vi.advanceTimersByTime(200)
    expect(tpsMeter.snapshot.live).toBe(true)

    un()
    expect(tpsMeter.snapshot.live).toBe(false)
    expect(tpsMeter.snapshot.ring).toEqual([])
    expect(tpsMeter.snapshot.ema).toBe(0)

    // 重新订阅：首帧不再显示过期 live（订阅时 events 为空 → live 强制 false）
    const snap2: TpsSample[] = []
    const un2 = subscribe((s) => snap2.push(s))
    expect(tpsMeter.snapshot.live).toBe(false)
    un2()
  })
})
