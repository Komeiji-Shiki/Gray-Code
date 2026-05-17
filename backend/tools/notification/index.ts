import type { Tool, ToolRegistration } from '../types'

export { createShowWindowsNotificationTool, createShowWindowsNotificationToolDeclaration, registerShowWindowsNotification } from './show_windows_notification'

export function getNotificationToolRegistrations(): ToolRegistration[] {
  const { registerShowWindowsNotification } = require('./show_windows_notification')
  return [registerShowWindowsNotification]
}

export function getAllNotificationTools(): Tool[] {
  const { registerShowWindowsNotification } = require('./show_windows_notification')
  return [registerShowWindowsNotification()]
}
