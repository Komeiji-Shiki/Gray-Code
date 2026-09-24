import { describe, expect, test } from 'vitest'
import { resolveRestoredWindowStart } from '../useVirtualMessageWindow'
import { advanceMessageWindowStart, computeMessageWindowPadding } from '../messageListUtils'

describe('virtual message window state restoration', () => {
  const messages = (count: number, prefix = 'm') =>
    Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }))

  test('消息前插后按稳定锚点恢复同一窗口位置', () => {
    const original = messages(300)
    const anchorMessageId = original[120].id
    const prepended = [...messages(40, 'older'), ...original]

    const restored = resolveRestoredWindowStart(prepended, 200, {
      windowStart: 100,
      anchorMessageId,
      anchorWindowOffset: 20
    })

    // 锚点从 120 右移到 160，仍放在窗口内第 20 项，所以新起点为 140。
    expect(restored).toBe(140)
    expect(prepended[restored + 20].id).toBe(anchorMessageId)
  })

  test('锚点不存在时恢复保存的 windowStart，而不是强制贴到最新消息', () => {
    expect(resolveRestoredWindowStart(messages(500), 200, {
      windowStart: 80,
      anchorMessageId: 'removed-message',
      anchorWindowOffset: 10
    })).toBe(80)
  })

  test('旧状态没有窗口信息时才回退到尾部窗口', () => {
    expect(resolveRestoredWindowStart(messages(500), 200, {})).toBe(300)
  })

  test('长历史已加载数组的窗口占位覆盖被裁剪消息', () => {
    const padding = computeMessageWindowPadding(1000, 420, 620, 80)

    expect(padding).toEqual({ top: 33600, bottom: 30400 })
    expect(padding.top + 200 * 80 + padding.bottom).toBe(80000)
  })

  test('窗口向下只前移一个步长，不直接贴到对话尾部', () => {
    expect(advanceMessageWindowStart(400, 200, 1000, 40)).toBe(440)
    expect(advanceMessageWindowStart(760, 200, 1000, 40)).toBe(800)
    expect(advanceMessageWindowStart(800, 200, 1000, 40)).toBe(800)
  })
})
