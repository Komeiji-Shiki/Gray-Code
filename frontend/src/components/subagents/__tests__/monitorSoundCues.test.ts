/**
 * monitorSoundCues - SubAgent Monitor 提示音触发规则测试
 *
 * 覆盖：
 * - run 状态迁移 → 提示音映射（非终态 → completed/failed；取消/中断/重复状态不播）
 * - 重试类事件 → 提示音映射（retrying/retryFailed；其余事件不播）
 * - playMonitorSubagentCue 把角色标注为 subagent 并转发给音效控制器
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/services/soundEventController', () => ({
  handleSoundEvent: vi.fn().mockResolvedValue(undefined)
}))

import { handleSoundEvent } from '@/services/soundEventController'
import {
  getRunStatusTransitionCue,
  getRunRetryEventCue,
  playMonitorSubagentCue
} from '../monitorSoundCues'

const mockedHandleSoundEvent = vi.mocked(handleSoundEvent)

describe('monitorSoundCues 子代理提示音规则', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getRunStatusTransitionCue 状态迁移映射', () => {
    it('运行中 → 完成：任务完成音', () => {
      expect(getRunStatusTransitionCue('running', 'completed')).toBe('taskComplete')
    })

    it('运行中 → 失败：任务失败音', () => {
      expect(getRunStatusTransitionCue('running', 'failed')).toBe('taskError')
    })

    it('排队/暂停/等待用户操作 → 终态：同样触发', () => {
      expect(getRunStatusTransitionCue('queued', 'completed')).toBe('taskComplete')
      expect(getRunStatusTransitionCue('paused', 'failed')).toBe('taskError')
      expect(getRunStatusTransitionCue('awaiting_monitor_action', 'failed')).toBe('taskError')
    })

    it('终态 → 终态不重复触发（completed 后再次 completed 不播）', () => {
      expect(getRunStatusTransitionCue('completed', 'completed')).toBeNull()
      expect(getRunStatusTransitionCue('failed', 'completed')).toBeNull()
    })

    it('取消/中断是用户侧终止，不播提示音', () => {
      expect(getRunStatusTransitionCue('running', 'cancelled')).toBeNull()
      expect(getRunStatusTransitionCue('running', 'interrupted')).toBeNull()
    })

    it('状态缺失时不做判断', () => {
      expect(getRunStatusTransitionCue(undefined, 'completed')).toBeNull()
      expect(getRunStatusTransitionCue('running', undefined)).toBeNull()
    })
  })

  describe('getRunRetryEventCue 重试事件映射', () => {
    it('retrying → 警告音', () => {
      expect(getRunRetryEventCue('retrying')).toBe('warning')
    })

    it('retryFailed → 错误音', () => {
      expect(getRunRetryEventCue('retryFailed')).toBe('error')
    })

    it('其余事件不播', () => {
      expect(getRunRetryEventCue('retrySuccess')).toBeNull()
      expect(getRunRetryEventCue('run_completed')).toBeNull()
      expect(getRunRetryEventCue('llm_delta')).toBeNull()
    })
  })

  describe('playMonitorSubagentCue', () => {
    it('以 role: subagent 转发给音效控制器，未传时间戳时使用当前时间', () => {
      playMonitorSubagentCue('taskComplete')

      expect(mockedHandleSoundEvent).toHaveBeenCalledTimes(1)
      expect(mockedHandleSoundEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          cue: 'taskComplete',
          source: 'taskEvent',
          role: 'subagent'
        })
      )
      const payload = mockedHandleSoundEvent.mock.calls[0][0]
      expect(typeof payload.createdAt).toBe('number')
    })

    it('保留外部传入的事件时间戳', () => {
      const createdAt = 1234567890
      playMonitorSubagentCue('taskError', createdAt)

      expect(mockedHandleSoundEvent).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt })
      )
    })
  })
})
