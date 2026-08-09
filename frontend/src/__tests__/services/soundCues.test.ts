/**
 * soundCues - 设置归一化与「主代理/子代理」角色感知门控测试
 *
 * 覆盖：
 * - normalizeUISoundSettings：子代理 cues.subagent 分组归一化（显式值 / 缺省回退）
 * - isCueEnabled：同一类提示音按角色（main/subagent）分别门控
 * - 旧版设置（无 subagent 分组）归一化后默认开启子代理开关（向后兼容）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_UI_SOUND_SETTINGS,
  normalizeUISoundSettings,
  configureSoundSettings,
  isCueEnabled
} from '../../services/soundCues'

describe('soundCues 子代理提示音设置', () => {
  beforeEach(() => {
    // 每个用例从默认设置出发，避免用例间状态泄漏
    configureSoundSettings(DEFAULT_UI_SOUND_SETTINGS)
  })

  describe('normalizeUISoundSettings', () => {
    it('缺省输入：子代理分组与主代理一致，全部开启', () => {
      const normalized = normalizeUISoundSettings(undefined)

      expect(normalized.cues.subagent).toEqual({
        warning: true,
        error: true,
        taskComplete: true,
        taskError: true
      })
    })

    it('旧版设置（无 cues.subagent 分组）：归一化后子代理分组回退默认开启，不破坏旧配置', () => {
      const normalized = normalizeUISoundSettings({
        enabled: true,
        cues: {
          warning: false,
          error: true,
          taskComplete: false,
          taskError: true
        }
      })

      expect(normalized.cues.warning).toBe(false)
      expect(normalized.cues.error).toBe(true)
      expect(normalized.cues.subagent).toEqual({
        warning: true,
        error: true,
        taskComplete: true,
        taskError: true
      })
    })

    it('显式子代理分组：逐项归一化，非布尔值回退默认', () => {
      const normalized = normalizeUISoundSettings({
        cues: {
          subagent: {
            warning: false,
            error: 'yes' as unknown as boolean,
            taskComplete: true,
            taskError: 0 as unknown as boolean
          }
        }
      })

      expect(normalized.cues.subagent.warning).toBe(false)
      expect(normalized.cues.subagent.error).toBe(true)
      expect(normalized.cues.subagent.taskComplete).toBe(true)
      expect(normalized.cues.subagent.taskError).toBe(true)
    })
  })

  describe('isCueEnabled 角色感知门控', () => {
    it('主代理与子代理的同一类提示音可分别开关', () => {
      configureSoundSettings({
        cues: {
          warning: false,
          subagent: {
            warning: true
          }
        }
      })

      expect(isCueEnabled('warning', 'main')).toBe(false)
      expect(isCueEnabled('warning', 'subagent')).toBe(true)
    })

    it('反向：子代理关闭、主代理开启', () => {
      configureSoundSettings({
        cues: {
          taskComplete: true,
          subagent: {
            taskComplete: false
          }
        }
      })

      expect(isCueEnabled('taskComplete', 'main')).toBe(true)
      expect(isCueEnabled('taskComplete', 'subagent')).toBe(false)
    })

    it('缺省角色按主代理处理（向后兼容）', () => {
      configureSoundSettings({
        cues: {
          taskError: false
        }
      })

      expect(isCueEnabled('taskError')).toBe(false)
      expect(isCueEnabled('taskError', 'main')).toBe(false)
    })

    it('四种提示音类型均按角色独立门控', () => {
      configureSoundSettings({
        cues: {
          warning: true,
          error: false,
          taskComplete: true,
          taskError: false,
          subagent: {
            warning: false,
            error: true,
            taskComplete: false,
            taskError: true
          }
        }
      })

      expect(isCueEnabled('warning', 'main')).toBe(true)
      expect(isCueEnabled('warning', 'subagent')).toBe(false)
      expect(isCueEnabled('error', 'main')).toBe(false)
      expect(isCueEnabled('error', 'subagent')).toBe(true)
      expect(isCueEnabled('taskComplete', 'main')).toBe(true)
      expect(isCueEnabled('taskComplete', 'subagent')).toBe(false)
      expect(isCueEnabled('taskError', 'main')).toBe(false)
      expect(isCueEnabled('taskError', 'subagent')).toBe(true)
    })
  })
})
