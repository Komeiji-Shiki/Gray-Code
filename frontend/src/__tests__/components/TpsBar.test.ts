/**
 * TpsBar 组件测试
 *
 * 覆盖：
 * - 初始空闲态：is-idle（整条淡出）
 * - 真实 tokenizer / 估算两种来源标记的显示
 * - 流结束后 EMA 自然衰减：归零前不消失（is-idle 不出现），完全归零后恢复 is-idle
 * - 流活跃停顿（agent 思考/工具执行）冻结真实曲线：不清空、保持活跃外观
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import TpsBar from '../../components/input/TpsBar.vue'
import { tpsMeter } from '../../utils/tpsMeter'

// mock chatStore：isStreaming / isWaitingForResponse 可控。
// 注意：Pinia store 访问属性时自动解包 ref，这里用 getter 模拟同样的行为，
// 否则 TpsBar 拿到的是恒 truthy 的 ref 对象，streamActive 判断会失效。
const isStreaming = ref(false)
const isWaitingForResponse = ref(false)

vi.mock('../../stores', () => ({
  useChatStore: () => ({
    get isStreaming() {
      return isStreaming.value
    },
    get isWaitingForResponse() {
      return isWaitingForResponse.value
    }
  })
}))

/** 从 record 开始推进采样，直到 EMA 与 ring 完全归零 */
function advanceUntilSettled(): void {
  for (let i = 0; i < 80; i++) vi.advanceTimersByTime(200)
}

let wrapper: VueWrapper | null = null

function mountBar() {
  wrapper = mount(TpsBar)
  // 挂载即订阅并消费快照；unmount 会退订 → tpsMeter 停表清空，用例间隔离
  return wrapper
}

describe('TpsBar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(1_000_000)
    isStreaming.value = false
    isWaitingForResponse.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
  })

  test('初始空闲：is-idle（整条淡出）且无来源标记', async () => {
    const wrapper = mountBar()
    await nextTick()
    expect(wrapper.get('.tps-bar').classes()).toContain('is-idle')
    expect(wrapper.find('.tps-source').exists()).toBe(false)
    wrapper.unmount()
  })

  test('真实 tokenizer 计数：显示绿色来源标记且不淡出', async () => {
    const wrapper = mountBar()

    tpsMeter.record(100, undefined, 'tokenizer')
    vi.advanceTimersByTime(200)
    await nextTick()

    const source = wrapper.get('.tps-source')
    expect(source.classes()).toContain('is-tokenizer')
    expect(source.attributes('title')).toContain('模型 tokenizer 精确计数')
    expect(wrapper.get('.tps-bar').classes()).not.toContain('is-idle')
    wrapper.unmount()
  })

  test('估算计数：显示估算来源标记', async () => {
    const wrapper = mountBar()

    tpsMeter.record(100, undefined, 'estimate')
    vi.advanceTimersByTime(200)
    await nextTick()

    const source = wrapper.get('.tps-source')
    expect(source.classes()).toContain('is-estimate')
    expect(source.attributes('title')).toContain('估算')
    wrapper.unmount()
  })

  test('流结束后自然衰减：归零前保持活跃（不强制清空），完全归零后淡出', async () => {
    const wrapper = mountBar()

    tpsMeter.record(100)
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(wrapper.get('.tps-bar').classes()).not.toContain('is-idle')

    // 流结束（无新 token）：EMA 开始衰减，2s 后 live=false 但曲线仍在 → 不淡出
    vi.advanceTimersByTime(2400)
    await nextTick()
    expect(tpsMeter.snapshot.live).toBe(false)
    expect(tpsMeter.snapshot.ema).toBeGreaterThan(0)
    expect(wrapper.get('.tps-bar').classes()).not.toContain('is-idle')

    // 完全归零（EMA 与 ring 全零）→ 恢复淡出态
    advanceUntilSettled()
    await nextTick()
    expect(tpsMeter.snapshot.ema).toBe(0)
    expect(tpsMeter.snapshot.ring.every((b) => b === 0)).toBe(true)
    expect(wrapper.get('.tps-bar').classes()).toContain('is-idle')
    wrapper.unmount()
  })

  test('流活跃停顿（agent 思考/工具执行）：冻结真实曲线，保持活跃外观', async () => {
    const wrapper = mountBar()

    tpsMeter.record(100)
    vi.advanceTimersByTime(200)
    await nextTick()

    // 超过 2s 无 token 且流仍活跃 → 冻结（is-live 保持、不淡出）
    isStreaming.value = true
    vi.advanceTimersByTime(3000)
    await nextTick()

    expect(tpsMeter.snapshot.live).toBe(false)
    expect(wrapper.get('.tps-bar').classes()).toContain('is-live')
    expect(wrapper.get('.tps-bar').classes()).not.toContain('is-idle')

    // 流结束后恢复空闲淡出
    isStreaming.value = false
    advanceUntilSettled()
    await nextTick()
    expect(wrapper.get('.tps-bar').classes()).toContain('is-idle')
    wrapper.unmount()
  })
})
