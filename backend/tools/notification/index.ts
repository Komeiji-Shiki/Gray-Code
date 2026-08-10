import type { Tool, ToolRegistration } from '../types'
import { registerShowWindowsNotification } from './show_windows_notification'

export { createShowWindowsNotificationTool, createShowWindowsNotificationToolDeclaration, registerShowWindowsNotification } from './show_windows_notification'

// 修改原因：旧实现同时有静态 re-export 和函数内的 require()，同一符号两条加载路径，
//          模块实例不共享且静态导出被重复声明。
// 修改方式：统一走静态导入，注册函数在模块加载时求值一次，两处使用同一引用。

export function getNotificationToolRegistrations(): ToolRegistration[] {
  return [registerShowWindowsNotification]
}

export function getAllNotificationTools(): Tool[] {
  return [registerShowWindowsNotification()]
}
