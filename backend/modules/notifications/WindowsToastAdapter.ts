import * as vscode from 'vscode'
import type { WindowsToastAdapter, WindowsToastRequest, WindowsToastShowResult } from './types'
import { Logger } from '../../core/logger'

const log = Logger.get('VSCodeNotificationAdapter')

/** 操作按钮文案（点击后打开 GrayCode 聊天面板） */
const OPEN_CHAT_ACTION = 'Open Chat'

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Unknown notification error'
}

/**
 * 基于 VS Code 原生通知的 WindowsToastAdapter 实现。
 *
 * 修改原因（F-07）：node-notifier 已停更，其传递依赖 uuid@8.3.2 触发生产依赖
 * 审计告警（GHSA-w5hq-g745-h8pq），且项目运行在 VS Code 扩展宿主中，原生通知
 * 能力足以替代系统 toast，无需再携带外部通知包及其原生二进制。
 * 修改方式：show() 调用 vscode.window.showInformationMessage 展示通知；不等待
 * 用户关闭通知，立即返回 shown: true；操作按钮结果异步处理，工具调用不会挂起。
 * 修改目的：去掉停更且有告警的生产依赖，同时保留「通知内容可见 + 打开聊天」行为。
 *
 * 行为差异（相对 node-notifier 的 Windows toast）：
 * - 「打开聊天」通过通知操作按钮触发，而不是点击通知任意区域触发。
 * - 通知声音由 VS Code 与系统设置管理，无法逐条强制静音或播放声音。
 * - 通知属于 VS Code 原生通知体系，窗口未聚焦时是否显示系统级横幅由 VS Code
 *   与 Windows 通知设置决定。
 */
export class VSCodeNotificationAdapter implements WindowsToastAdapter {
  async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
    log.debug('show_called', {
      title: request.title,
      message: request.message,
      silent: request.silent,
      waitForAction: request.waitForAction,
      hasOnClick: typeof request.onClick === 'function'
    })

    try {
      const openAction = request.onClick ? OPEN_CHAT_ACTION : undefined
      const notificationPromise = vscode.window.showInformationMessage(
        request.title,
        { detail: request.message, modal: false },
        ...(openAction ? [openAction] : [])
      )

      // 不等待用户关闭通知：显示结果异步处理，避免工具调用长时间挂起。
      // 通知 API 同步抛错会被 try/catch 捕获并返回 shown: false；
      // 异步 reject 无法在不挂起的前提下感知，只记录日志。
      void Promise.resolve(notificationPromise)
        .then(selected => {
          if (selected === openAction && request.onClick) {
            void Promise.resolve(request.onClick()).catch(error => {
              log.error('on_click_failed', { error: toErrorMessage(error) })
            })
          }
        })
        .catch(error => {
          log.error('notification_api_failed', { error: toErrorMessage(error) })
        })

      return { shown: true }
    } catch (error) {
      log.error('show_threw', { error: toErrorMessage(error) })
      return { shown: false, error: toErrorMessage(error) }
    }
  }
}
