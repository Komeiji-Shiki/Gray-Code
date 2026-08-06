import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActivityStatsResult from '../ActivityStatsResult.vue'

/**
 * get_activity_stats 工具结果展示组件测试
 */

function makeDay(date: string, totalMinutes: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    date,
    totalMinutes,
    sessionCount: totalMinutes > 0 ? 2 : 0,
    firstActiveAt: totalMinutes > 0 ? '02:10' : null,
    lastActiveAt: totalMinutes > 0 ? '11:11' : null,
    ...extra
  }
}

function makeHeatRow(date: string, activeHours: Array<[number, number]> = []) {
  const hours = new Array(24).fill(0)
  for (const [hour, minutes] of activeHours) {
    hours[hour] = minutes
  }
  return { date, hours }
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-08-06 11:11',
    today: {
      date: '2026-08-06',
      totalMinutes: 168,
      sessionCount: 4,
      firstActiveAt: '02:10',
      lastActiveAt: '11:11'
    },
    currentSession: { active: true, startedAt: '11:06', minutes: 5 },
    daily: [
      makeDay('2026-08-06', 168),
      makeDay('2026-08-05', 0),
      makeDay('2026-08-04', 0),
      makeDay('2026-08-03', 0),
      makeDay('2026-08-02', 0),
      makeDay('2026-08-01', 0),
      makeDay('2026-07-31', 0)
    ],
    monthly: [],
    hourlyHeatmap: [
      makeHeatRow('2026-07-31'),
      makeHeatRow('2026-08-01'),
      makeHeatRow('2026-08-02'),
      makeHeatRow('2026-08-03'),
      makeHeatRow('2026-08-04'),
      makeHeatRow('2026-08-05'),
      makeHeatRow('2026-08-06', [[2, 50], [8, 60]])
    ],
    ...overrides
  }
}

function mountStats(result?: Record<string, unknown>, args: Record<string, unknown> = {}) {
  return mount(ActivityStatsResult, {
    props: {
      args,
      result
    }
  })
}

describe('ActivityStatsResult', () => {
  it('无 result 时显示等待状态', () => {
    const wrapper = mountStats(undefined)
    const state = wrapper.get('.as-state')
    expect(state.text()).toContain('正在统计')
    wrapper.unmount()
  })

  it('失败时显示错误信息', () => {
    const wrapper = mountStats({ success: false, error: 'Activity tracker is not initialized' })
    const state = wrapper.get('.as-state.is-error')
    expect(state.text()).toContain('Activity tracker is not initialized')
    wrapper.unmount()
  })

  it('成功时渲染总览、每日条形图和热力图', () => {
    const wrapper = mountStats({ success: true, data: makeData() })

    // 头部：标题 + 生成时间
    expect(wrapper.get('.as-title').text()).toContain('Activity Stats')
    expect(wrapper.get('.as-generated').text()).toBe('2026-08-06 11:11')

    // 总览三列：今日 2小时48分钟 / 当前会话 5分钟 / 合计 2小时48分钟
    const totals = wrapper.findAll('.as-total-value')
    expect(totals).toHaveLength(3)
    expect(totals[0].text()).toBe('2小时48分钟')
    expect(totals[1].text()).toBe('5分钟')
    expect(totals[2].text()).toBe('2小时48分钟')

    // 每日条形图：7 天
    expect(wrapper.findAll('.as-day')).toHaveLength(7)

    // 热力图：7 行 × 24 格
    expect(wrapper.findAll('.as-heat-row')).toHaveLength(7)
    expect(wrapper.findAll('.as-heat-cell')).toHaveLength(7 * 24)

    // 无月度数据时不显示月度区块
    expect(wrapper.find('.as-month').exists()).toBe(false)
    wrapper.unmount()
  })

  it('当前会话未活跃时显示 —', () => {
    const data = makeData({ currentSession: { active: false, startedAt: null, minutes: 0 } })
    const wrapper = mountStats({ success: true, data })
    const totals = wrapper.findAll('.as-total-value')
    expect(totals[1].text()).toBe('—')
    wrapper.unmount()
  })

  it('每日数据超过 31 天时截断并显示提示', () => {
    const daily = []
    for (let i = 0; i < 40; i++) {
      const date = new Date(Date.UTC(2026, 6, 1) + i * 86400000)
      daily.push(makeDay(date.toISOString().slice(0, 10), i === 39 ? 120 : 0))
    }
    const data = makeData({ daily })
    const wrapper = mountStats({ success: true, data })

    // 只渲染最近 31 天（最新在前，最新一天为 08-09）
    const dayRows = wrapper.findAll('.as-day')
    expect(dayRows).toHaveLength(31)
    expect(dayRows[0].text()).toContain('08-09')
    expect(dayRows[30].text()).toContain('07-10')
    expect(wrapper.get('.as-block-note').text()).toContain('仅显示最近 31 天')
    wrapper.unmount()
  })

  it('长范围且存在月度数据时显示月度概览', () => {
    const daily = []
    for (let i = 0; i < 45; i++) {
      const date = new Date(Date.UTC(2026, 5, 1) + i * 86400000)
      daily.push(makeDay(date.toISOString().slice(0, 10), i === 44 ? 90 : 0))
    }
    const data = makeData({
      daily,
      monthly: [
        { month: '2026-06', totalMinutes: 30, activeDays: 1, sessionCount: 2 },
        { month: '2026-07', totalMinutes: 90, activeDays: 1, sessionCount: 2 }
      ]
    })
    const wrapper = mountStats({ success: true, data })

    expect(wrapper.findAll('.as-month')).toHaveLength(2)
    expect(wrapper.get('.as-month-value').text()).toContain('30')
    wrapper.unmount()
  })

  it('短范围即使有月度数据也不显示月度概览', () => {
    const data = makeData({
      monthly: [{ month: '2026-08', totalMinutes: 168, activeDays: 1, sessionCount: 4 }]
    })
    const wrapper = mountStats({ success: true, data })
    expect(wrapper.find('.as-month').exists()).toBe(false)
    wrapper.unmount()
  })
})
