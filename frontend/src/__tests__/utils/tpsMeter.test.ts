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
 * - 突发摊薄：单事件 > 250 token 拆分散布，速率硬上限（1200 tok/s）生效
 * - 总量守恒：拆分后的小事件之和等于原始输入
 * - 回放/积压：record(500, 过去时间戳) 后事件立即被窗口修剪，不产生尖峰
 * - API 兼容：record(n) 单参数调用不受影响
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
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
  test('1s 窗口累计 token → 瞬时速率（total / 1s）', () => {
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

  test('1s 窗口修剪：过期事件不再计入', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    // 200 < 250（低于突发摊薄阈值），保证该用例只测窗口修剪语义
    tpsMeter.record(200) // t=0
    vi.advanceTimersByTime(1000) // 采样 @200..1000；@1000 时 record@0 仍在窗口内
    tpsMeter.record(200) // t=1000
    vi.advanceTimersByTime(200) // 采样 @1200：record@0 已过期被修剪 → total=200

    const last = samples[samples.length - 1]
    // 若未修剪：total=400 → 速率 400，ema 会显著高于 200
    expect(last.ema).toBeCloseTo(200, 5)
    expect(last.ema).toBeLessThan(300)
  })

  test('乱序到达：旧时间戳事件后到也会被窗口修剪，不污染实时速率', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(100) // t=now，正常事件
    tpsMeter.record(200, Date.now() - 5000) // 乱序：时间戳更旧的事件后到
    vi.advanceTimersByTime(200)

    // 窗口内只有 t=now 的 100 token；乱序旧事件被扫描式修剪（不能按插入序 shift）
    expect(samples[0].ema).toBeCloseTo(100, 5)
  })

  test('EMA 平滑：首次=瞬时速率，之后 ema = ema×0.7 + rate×0.3', () => {
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

  test('ring 定长：超过 30 点只保留最近 30 点', () => {
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

describe('突发摊薄与速率上限', () => {
  test('record(3000) 摊薄后单次采样速率受限（硬上限生效）且非零', () => {
    // 3000 > 250 → 摊薄为 12 个小事件（各 ~250 token），时间均匀分布在 [-1000, 0]
    tpsMeter.record(3000) // t=0
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    vi.advanceTimersByTime(200) // 首个采样 @200：窗口内约 2250 token → 未封顶速率 ≈ 2250

    // 硬上限 MAX_RATE=1200 生效：远低于未封顶的 ~2250，且非零（事件未被全部丢弃）
    expect(samples[0].ema).toBeGreaterThan(0)
    expect(samples[0].ema).toBeLessThanOrEqual(1200)
    expect(samples[0].ema).toBeLessThan(2000)

    // 持续采样期间速率始终受控
    vi.advanceTimersByTime(2000)
    for (const s of samples) {
      expect(s.ema).toBeLessThanOrEqual(1200)
    }
  })

  test('突发摊薄总量守恒：拆分后小事件之和等于原始输入', () => {
    // 用显式未来时间戳使全部摊薄小事件落在同一个 1s 采样窗口内（fake timers 下确定）：
    // 260 > 250 → 拆成 2 个事件（130 + 130），散布在 [t-1000, t]，t = now + 1000
    tpsMeter.record(260, Date.now() + 1000)
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    vi.advanceTimersByTime(200)

    // 窗口内 total=260 → rate=260（未触发上限）→ 首次采样 ema=260，证明拆分总量守恒
    expect(samples[0].ema).toBeCloseTo(260, 5)
  })

  test('回放/积压：record(500, 过去时间戳) 后事件立即被修剪，不产生尖峰', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    // 模拟后台积压回放：事件真实发生时间在 1s 窗口之外 → 首次采样即被修剪（摊薄事件一并修剪）
    tpsMeter.record(500, Date.now() - 5000)
    vi.advanceTimersByTime(200)

    expect(samples[samples.length - 1].ema).toBe(0)
    // live 判定基于真实接收时刻（调用时刻），与事件时间戳无关 → 仍为 true
    expect(samples[samples.length - 1].live).toBe(true)
  })
})

describe('live 判定', () => {
  test('2s 内有真实 record → live=true，超过 2s → live=false', () => {
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
  test('无订阅（停表）时 record 超 1000 条仍受控：丢最旧', () => {
    // 停表状态（无订阅）：事件缓冲不应无界增长
    for (let i = 0; i < 1100; i++) tpsMeter.record(1)

    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))
    vi.advanceTimersByTime(200)

    // 只保留最近 1000 条 → 窗口 total=1000 → 速率 1000（若未裁剪应为 1100）
    expect(samples[0].ema).toBeCloseTo(1000, 5)
  })

  test('容量上限乱序修剪：丢弃时间戳最旧的事件（而非插入序最旧）', () => {
    // 1100 条事件，最后插入的一条时间戳最旧（乱序后到）
    tpsMeter.record(1) // t=now
    for (let i = 0; i < 1098; i++) tpsMeter.record(1) // 连续 t=now
    tpsMeter.record(1, Date.now() - 100000) // 最后插入但时间戳最旧

    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))
    vi.advanceTimersByTime(200)

    // 正确实现：超限时按时间戳扫描丢最旧 → 丢掉乱序旧事件，窗口 total=1000
    // 若按插入序 shift：会保留乱序旧事件（随后被窗口修剪）→ total=999
    expect(samples[0].ema).toBeCloseTo(1000, 5)
  })
})

describe('自然归零', () => {
  test('无事件时 EMA 指数衰减到阈值以下 → 精确归零（UI 可稳定判定）', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(100) // t=0
    vi.advanceTimersByTime(200) // @200: 首次采样 ema=100
    expect(samples[0].ema).toBe(100)

    // 事件过期后不再有 token 到达：EMA 每 200ms ×0.7 指数衰减
    for (let i = 0; i < 40; i++) vi.advanceTimersByTime(200) // 再推 8s
    const last = samples[samples.length - 1]
    expect(last.ema).toBe(0)
    expect(last.ring[last.ring.length - 1]).toBe(0)
    // 衰减过程可见：并非一停流就瞬间归零
    expect(samples.some((s) => s.ema > 0 && s.ema < 100)).toBe(true)
  })
})

describe('退订与状态清理', () => {
  test('最后一个订阅者取消后停表：不再采样', () => {
    const samples: TpsSample[] = []
    const un = subscribe((s) => samples.push(s))

    vi.advanceTimersByTime(200)
    expect(samples).toHaveLength(1)

    un()
    const count = samples.length
    vi.advanceTimersByTime(2000)
    expect(samples).toHaveLength(count)
  })

  test('停表后状态清理：快照 live 强制 false、无过期曲线', () => {
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


describe('计数来源标记', () => {
  test('record 带 source 后快照携带来源；不带 source 保持 null（旧调用兼容）', () => {
    const samples: TpsSample[] = []
    subscribe((s) => samples.push(s))

    tpsMeter.record(10) // 不带 source：不更新来源
    vi.advanceTimersByTime(200)
    expect(samples[0].source).toBeNull()

    tpsMeter.record(10, undefined, 'tokenizer')
    vi.advanceTimersByTime(200)
    expect(samples[1].source).toBe('tokenizer')

    // 衰减期（非 live）来源保持——曲线数据仍是上次真实计数的延续
    vi.advanceTimersByTime(2400)
    const last = samples[samples.length - 1]
    expect(last.live).toBe(false)
    expect(last.source).toBe('tokenizer')

    // 来源可切换（tokenizer 就绪/未就绪交替）
    tpsMeter.record(10, undefined, 'estimate')
    vi.advanceTimersByTime(200)
    expect(samples[samples.length - 1].source).toBe('estimate')
  })

  test('停表清空后 source 归 null', () => {
    const un = subscribe(() => {})
    tpsMeter.record(10, undefined, 'estimate')
    vi.advanceTimersByTime(200)
    expect(tpsMeter.snapshot.source).toBe('estimate')

    un()
    expect(tpsMeter.snapshot.source).toBeNull()
  })
})