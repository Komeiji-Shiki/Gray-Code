import { isNotificationQuiet, validateNotificationQuietHours } from '../../../shared/notificationPolicy'
import { WindowsAgentStopNotificationService } from '../../modules/notifications/AgentStopNotificationRuntime'
import type { GlobalSettings } from '../../modules/settings/types'

describe('通知免打扰', () => {
  test('按所选时区处理跨午夜时间，结束分钟恢复通知', () => {
    const hours = { mode: 'schedule' as const, start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' }
    expect(isNotificationQuiet(hours, Date.parse('2026-09-13T13:59:00Z'))).toBe(false)
    expect(isNotificationQuiet(hours, Date.parse('2026-09-13T14:00:00Z'))).toBe(true)
    expect(isNotificationQuiet(hours, Date.parse('2026-09-13T23:59:00Z'))).toBe(true)
    expect(isNotificationQuiet(hours, Date.parse('2026-09-14T00:00:00Z'))).toBe(false)
    const daytime = { ...hours, start: '09:00', end: '12:00' }
    expect(isNotificationQuiet(daytime, Date.parse('2026-09-14T02:00:00Z'))).toBe(true)
    expect(isNotificationQuiet(daytime, Date.parse('2026-09-14T05:00:00Z'))).toBe(false)
    expect(isNotificationQuiet(undefined)).toBe(false)
    expect(() => validateNotificationQuietHours({ ...hours, end: hours.start })).toThrow('开始和结束')
    expect(() => validateNotificationQuietHours({ ...hours, timeZone: 'invalid' })).toThrow('时区无效')
  })

  test('真实通知服务在设置改变后即时遵循免打扰，暂停期间不占用通知去重键', async () => {
    const settings = { ui: { sound: { quietHours: { mode: 'always' }, windowsAgentStopNotification: { enabled: true, onlyWhenWindowNotFocused: false } } } } as GlobalSettings
    const show = jest.fn(async () => ({ shown: true }))
    const service = new WindowsAgentStopNotificationService({ platform: 'win32', settingsManager: { getSettings: () => settings }, adapter: { show },
      getWindowTitle: () => '陪伴验收', getWindowState: () => ({ focused: false }), onDidChangeWindowState: () => ({ dispose() {} }), executeCommand: async () => {}, focusWindow: async () => {} })
    try {
      const payload = { reason: 'continue_required' as const, dedupeKey: 'reminder-1', createdAt: Date.now() }
      expect(await service.notify(payload)).toMatchObject({ shown: false, reason: 'do_not_disturb' })
      expect(show).not.toHaveBeenCalled()
      settings.ui!.sound!.quietHours = { mode: 'off' }
      expect(await service.notify(payload)).toMatchObject({ shown: true })
      expect(show).toHaveBeenCalledTimes(1)
    } finally { service.dispose() }
  })
})
