import * as vscode from 'vscode'
import { t } from '../../i18n'
import type { SettingsManager } from '../settings'
import { VSCodeNotificationAdapter } from './WindowsToastAdapter'
import { renderWindowsAgentStopTemplate } from './templateRenderer'
import { deriveWindowsAgentStopWindowTitle } from './windowTitle'
import type {
  AgentStopNotificationDispatchResult,
  AgentStopNotificationPayload,
  AgentStopNotificationReason,
  PendingAgentActionType,
  WindowsAgentStopNotificationContentOverride,
  WindowsNotificationPreviewPayload,
  WindowsToastAdapter,
  WindowsToastShowResult
} from './types'
import { Logger } from '../../core/logger'

const log = Logger.get('WindowsAgentStopNotification')
const APP_NAME = 'GrayCode'

interface ResolvedWindowsAgentStopNotificationContentSettings {
  titleTemplate: string
  bodyTemplates: {
    error: string
    awaitingUserAction: string
    continueRequired: string
  }
}

interface ResolvedWindowsAgentStopNotificationSettings {
  enabled: boolean
  onlyWhenWindowNotFocused: boolean
  cases: {
    error: boolean
    awaitingUserAction: boolean
    continueRequired: boolean
  }
  content: ResolvedWindowsAgentStopNotificationContentSettings
}

const DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT: ResolvedWindowsAgentStopNotificationContentSettings = {
  titleTemplate: '{windowTitle} · GrayCode',
  bodyTemplates: {
    error: 'GrayCode 已停止，请返回处理。',
    awaitingUserAction: 'GrayCode 正在等待：{actionLabel}。',
    continueRequired: 'GrayCode 已暂停，可继续处理。'
  }
}

export interface WindowsAgentStopNotificationServiceOptions {
  settingsManager: Pick<SettingsManager, 'getSettings'>
  adapter?: WindowsToastAdapter
  platform?: NodeJS.Platform
  getWindowState?: () => { focused: boolean }
  onDidChangeWindowState?: (
    listener: (state: { focused: boolean }) => void
  ) => { dispose: () => void }
  executeCommand?: (command: string) => Promise<unknown> | Thenable<unknown>
  logger?: Pick<Console, 'warn' | 'error'>
  dedupeTtlMs?: number
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeTemplateString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function resolveContentSettings(
  base?: WindowsAgentStopNotificationContentOverride
): ResolvedWindowsAgentStopNotificationContentSettings {
  return {
    titleTemplate: normalizeTemplateString(base?.titleTemplate, DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT.titleTemplate),
    bodyTemplates: {
      error: normalizeTemplateString(base?.bodyTemplates?.error, DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT.bodyTemplates.error),
      awaitingUserAction: normalizeTemplateString(base?.bodyTemplates?.awaitingUserAction, DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT.bodyTemplates.awaitingUserAction),
      continueRequired: normalizeTemplateString(base?.bodyTemplates?.continueRequired, DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT.bodyTemplates.continueRequired)
    }
  }
}

function mergeContentSettings(
  base: ResolvedWindowsAgentStopNotificationContentSettings,
  override?: WindowsAgentStopNotificationContentOverride
): ResolvedWindowsAgentStopNotificationContentSettings {
  return {
    titleTemplate: normalizeTemplateString(override?.titleTemplate, base.titleTemplate),
    bodyTemplates: {
      error: normalizeTemplateString(override?.bodyTemplates?.error, base.bodyTemplates.error),
      awaitingUserAction: normalizeTemplateString(override?.bodyTemplates?.awaitingUserAction, base.bodyTemplates.awaitingUserAction),
      continueRequired: normalizeTemplateString(override?.bodyTemplates?.continueRequired, base.bodyTemplates.continueRequired)
    }
  }
}

export class WindowsAgentStopNotificationService {
  private readonly adapter: WindowsToastAdapter
  private readonly platform: NodeJS.Platform
  private readonly getWindowState: () => { focused: boolean }
  private readonly onDidChangeWindowState: (
    listener: (state: { focused: boolean }) => void
  ) => { dispose: () => void }
  private readonly executeCommand: (command: string) => Promise<unknown> | Thenable<unknown>
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly dedupeTtlMs: number
  private readonly dedupeByKey = new Map<string, number>()

  private windowFocused = false
  private windowStateDisposable?: { dispose: () => void }

  constructor(options: WindowsAgentStopNotificationServiceOptions) {
    this.adapter = options.adapter ?? new VSCodeNotificationAdapter()
    this.platform = options.platform ?? process.platform
    this.getWindowState = options.getWindowState ?? (() => vscode.window.state)
    this.onDidChangeWindowState = options.onDidChangeWindowState ?? vscode.window.onDidChangeWindowState
    this.executeCommand = options.executeCommand ?? ((command: string) => vscode.commands.executeCommand(command))
    this.logger = options.logger ?? console
    this.dedupeTtlMs = options.dedupeTtlMs ?? 5 * 60 * 1000
    this.settingsManager = options.settingsManager

    this.windowFocused = !!this.getWindowState().focused
    log.debug('service_initialized', {
      platform: this.platform,
      windowFocused: this.windowFocused
    })

    this.windowStateDisposable = this.onDidChangeWindowState((state) => {
      this.windowFocused = !!state.focused
      log.debug('window_focus_changed', {
        windowFocused: this.windowFocused
      })
    })
  }

  private readonly settingsManager: Pick<SettingsManager, 'getSettings'>

  private getSettings(): ResolvedWindowsAgentStopNotificationSettings {
    const raw = this.settingsManager.getSettings().ui?.sound?.windowsAgentStopNotification

    return {
      enabled: raw?.enabled === true,
      onlyWhenWindowNotFocused: raw?.onlyWhenWindowNotFocused !== false,
      cases: {
        error: raw?.cases?.error !== false,
        awaitingUserAction: raw?.cases?.awaitingUserAction !== false,
        continueRequired: raw?.cases?.continueRequired !== false
      },
      content: resolveContentSettings(raw?.content)
    }
  }

  private cleanupExpiredDedupes(now = Date.now()): void {
    for (const [key, createdAt] of Array.from(this.dedupeByKey.entries())) {
      if (now - createdAt > this.dedupeTtlMs) {
        this.dedupeByKey.delete(key)
      }
    }
  }

  private isReasonEnabled(
    reason: AgentStopNotificationReason,
    settings: ResolvedWindowsAgentStopNotificationSettings
  ): boolean {
    if (reason === 'error') return settings.cases.error
    if (reason === 'awaiting_user_action') return settings.cases.awaitingUserAction
    if (reason === 'continue_required') return settings.cases.continueRequired
    // 未知 reason（运行时防御）：不再静默按 continueRequired，按 error 处理并告警
    this.logger.warn(`[windows-agent-stop-notification] unknown reason "${String(reason)}", treating as error`)
    return settings.cases.error
  }

  private isDuplicate(dedupeKey: string): boolean {
    return this.dedupeByKey.has(dedupeKey)
  }

  private rememberDedupe(dedupeKey: string, createdAt: number): void {
    this.dedupeByKey.set(dedupeKey, createdAt)
  }

  private getReasonLabel(reason: AgentStopNotificationReason): string {
    switch (reason) {
      case 'error':
        return t('notifications.windowsAgentStop.reasonLabels.error')
      case 'awaiting_user_action':
        return t('notifications.windowsAgentStop.reasonLabels.awaitingUserAction')
      case 'continue_required':
        return t('notifications.windowsAgentStop.reasonLabels.continueRequired')
      default:
        // 未知 reason（运行时防御）：不再静默按 continueRequired，按 error 处理并告警
        this.logger.warn(`[windows-agent-stop-notification] unknown reason "${String(reason)}", using error label`)
        return t('notifications.windowsAgentStop.reasonLabels.error')
    }
  }

  private getActionLabel(actionType?: PendingAgentActionType): string | undefined {
    switch (actionType) {
      case 'generate_plan':
        return t('notifications.windowsAgentStop.actionLabels.generatePlan')
      case 'execute_plan':
        return t('notifications.windowsAgentStop.actionLabels.executePlan')
      case 'continue':
        return t('notifications.windowsAgentStop.actionLabels.continue')
      case 'generic_confirmation':
        return t('notifications.windowsAgentStop.actionLabels.genericConfirmation')
      default:
        return undefined
    }
  }

  private resolveActionLabel(
    reason: AgentStopNotificationReason,
    actionType?: PendingAgentActionType,
    explicitActionLabel?: string
  ): string | undefined {
    const provided = normalizeText(explicitActionLabel)
    if (provided) {
      return provided
    }

    const fromActionType = this.getActionLabel(actionType)
    if (fromActionType) {
      return fromActionType
    }

    if (reason === 'awaiting_user_action') {
      return t('notifications.windowsAgentStop.actionLabels.genericConfirmation')
    }

    if (reason === 'continue_required') {
      return t('notifications.windowsAgentStop.actionLabels.continue')
    }

    return undefined
  }

  private getBodyTemplateForReason(
    reason: AgentStopNotificationReason,
    content: ResolvedWindowsAgentStopNotificationContentSettings
  ): string {
    if (reason === 'error') return content.bodyTemplates.error
    if (reason === 'awaiting_user_action') return content.bodyTemplates.awaitingUserAction
    if (reason === 'continue_required') return content.bodyTemplates.continueRequired
    // 未知 reason（运行时防御）：不再静默按 continueRequired，按 error 模板处理并告警
    this.logger.warn(`[windows-agent-stop-notification] unknown reason "${String(reason)}", using error template`)
    return content.bodyTemplates.error
  }

  private buildRenderedNotification(
    reason: AgentStopNotificationReason,
    content: ResolvedWindowsAgentStopNotificationContentSettings,
    options: {
      actionType?: PendingAgentActionType
      actionLabel?: string
    }
  ): {
    title: string
    message: string
    windowTitle: string
    reasonLabel: string
    actionLabel?: string
  } {
    const windowTitle = deriveWindowsAgentStopWindowTitle()
    const reasonLabel = this.getReasonLabel(reason)
    const actionLabel = this.resolveActionLabel(reason, options.actionType, options.actionLabel)
    const context = {
      appName: APP_NAME,
      windowTitle,
      actionLabel,
      reasonLabel
    }

    const title = normalizeText(renderWindowsAgentStopTemplate(content.titleTemplate, context))
      || renderWindowsAgentStopTemplate(DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT.titleTemplate, context)
      || APP_NAME

    const bodyTemplate = this.getBodyTemplateForReason(reason, content)
    const defaultBodyTemplate = this.getBodyTemplateForReason(reason, DEFAULT_WINDOWS_AGENT_STOP_NOTIFICATION_CONTENT)
    const message = normalizeText(renderWindowsAgentStopTemplate(bodyTemplate, context))
      || renderWindowsAgentStopTemplate(defaultBodyTemplate, context)
      || title

    return {
      title,
      message,
      windowTitle,
      reasonLabel,
      actionLabel
    }
  }

  private async handleNotificationClick(): Promise<void> {
    try {
      log.debug('notification_click_execute_open_chat')
      await this.executeCommand('graycode.openChat')
      log.debug('open_chat_executed')
    } catch (error) {
      this.logger.error('[windows-agent-stop-notification] Failed to focus chat view:', error)
    }
  }

  private async showToast(title: string, message: string): Promise<AgentStopNotificationDispatchResult> {
    log.debug('show_toast_invoked', {
      title,
      message,
      windowFocused: this.windowFocused
    })

    let toastResult: WindowsToastShowResult
    try {
      toastResult = await this.adapter.show({
        title,
        message,
        silent: true,
        waitForAction: true,
        onClick: () => this.handleNotificationClick()
      })
    } catch (error) {
      // adapter.show() 抛异常（而非返回 {shown:false}）：同样按失败处理，
      // notify 的失败路径会回滚去重键，避免异常路径下去重键滞留导致后续通知被误判为 duplicate
      this.logger.warn('[windows-agent-stop-notification] showToast threw:', error)
      return { shown: false, skipped: true, reason: 'adapter_error' }
    }

    if (!toastResult.shown) {
      log.debug('toast_not_shown', { ...toastResult })

      if (toastResult.error) {
        this.logger.warn('[windows-agent-stop-notification] Failed to show toast:', toastResult.error)
      }

      return {
        shown: false,
        skipped: true,
        reason: toastResult.skippedReason || (toastResult.error ? 'adapter_error' : 'not_shown')
      }
    }

    log.debug('toast_shown')

    return {
      shown: true,
      skipped: false
    }
  }

  async notify(payload: AgentStopNotificationPayload): Promise<AgentStopNotificationDispatchResult> {
    const now = Date.now()
    this.cleanupExpiredDedupes(now)

    log.debug('notify_called', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      conversationId: payload.conversationId,
      actionType: payload.actionType,
      windowFocused: this.windowFocused
    })

    if (this.platform !== 'win32') {
      log.debug('skip_notify_not_win32', { platform: this.platform })
      return {
        shown: false,
        skipped: true,
        reason: 'unsupported_platform'
      }
    }

    const settings = this.getSettings()
    log.debug('resolved_notification_settings', { ...settings })

    if (!settings.enabled) {
      log.debug('skip_notify_disabled')
      return {
        shown: false,
        skipped: true,
        reason: 'disabled'
      }
    }

    if (!this.isReasonEnabled(payload.reason, settings)) {
      log.debug('skip_notify_reason_disabled', {
        reason: payload.reason
      })
      return {
        shown: false,
        skipped: true,
        reason: 'case_disabled'
      }
    }

    if (settings.onlyWhenWindowNotFocused && this.windowFocused) {
      log.debug('skip_notify_window_focused')
      return {
        shown: false,
        skipped: true,
        reason: 'window_focused'
      }
    }

    const dedupeKey = normalizeText(payload.dedupeKey)
    if (!dedupeKey) {
      log.debug('skip_notify_missing_dedupe_key')
      return {
        shown: false,
        skipped: true,
        reason: 'missing_dedupe_key'
      }
    }

    if (this.isDuplicate(dedupeKey)) {
      log.debug('skip_notify_duplicate_dedupe_key', {
        dedupeKey
      })
      return {
        shown: false,
        skipped: true,
        reason: 'duplicate'
      }
    }

    // 先记录去重键再弹窗：两个并发相同 dedupeKey 的 notify 在 JS 单线程内
    // 会在第一个 await（showToast）之前同步完成 check+record，保证只弹一次
    this.rememberDedupe(dedupeKey, now)
    log.debug('dedupe_key_remembered', {
      dedupeKey,
      storedAt: now
    })

    const rendered = this.buildRenderedNotification(payload.reason, settings.content, {
      actionType: payload.actionType,
      actionLabel: payload.actionLabel
    })
    log.debug('rendered_notification_content', {
      reason: payload.reason,
      title: rendered.title,
      message: rendered.message,
      windowTitle: rendered.windowTitle,
      reasonLabel: rendered.reasonLabel,
      actionLabel: rendered.actionLabel
    })

    const result = await this.showToast(rendered.title, rendered.message)
    if (!result.shown) {
      // 回滚去重键：toast 未显示（权限/失败）时不应占住去重键，
      // 否则后续通知被误判为 duplicate，用户永远收不到
      this.dedupeByKey.delete(dedupeKey)
      log.debug('dedupe_key_rolled_back', { dedupeKey })
      return result
    }

    return result
  }

  async preview(payload: WindowsNotificationPreviewPayload): Promise<AgentStopNotificationDispatchResult> {
    log.debug('preview_called', {
      reason: payload.reason,
      actionType: payload.actionType,
      hasContentOverride: !!payload.content,
      windowFocused: this.windowFocused
    })

    if (this.platform !== 'win32') {
      log.debug('skip_preview_not_win32', { platform: this.platform })
      return {
        shown: false,
        skipped: true,
        reason: 'unsupported_platform'
      }
    }

    const settings = this.getSettings()
    const content = mergeContentSettings(settings.content, payload.content)
    const rendered = this.buildRenderedNotification(payload.reason, content, {
      actionType: payload.actionType,
      actionLabel: payload.actionLabel
    })

    log.debug('rendered_preview_content', {
      reason: payload.reason,
      title: rendered.title,
      message: rendered.message,
      windowTitle: rendered.windowTitle,
      reasonLabel: rendered.reasonLabel,
      actionLabel: rendered.actionLabel
    })

    const result = await this.showToast(rendered.title, rendered.message)
    log.debug('preview_finished', { ...result })
    return result
  }

  dispose(): void {
    this.windowStateDisposable?.dispose()
    this.windowStateDisposable = undefined
    this.dedupeByKey.clear()
    log.debug('service_disposed')
  }
}
