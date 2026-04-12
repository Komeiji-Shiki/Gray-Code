import * as vscode from 'vscode'
import { t } from '../../i18n'
import type { SettingsManager } from '../settings/SettingsManager'
import { NodeNotifierWindowsToastAdapter } from './WindowsToastAdapter'
import { renderWindowsAgentStopTemplate } from './templateRenderer'
import { deriveWindowsAgentStopWindowTitle } from './windowTitle'
import type {
  AgentStopNotificationDispatchResult,
  AgentStopNotificationPayload,
  AgentStopNotificationReason,
  PendingAgentActionType,
  WindowsAgentStopNotificationContentOverride,
  WindowsNotificationPreviewPayload,
  WindowsToastAdapter
} from './types'

const LOG_PREFIX = '[windows-agent-stop-notification][host]'
const APP_NAME = 'LimCode'

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
  titleTemplate: '{windowTitle} · LimCode',
  bodyTemplates: {
    error: 'LimCode 已停止，请返回处理。',
    awaitingUserAction: 'LimCode 正在等待：{actionLabel}。',
    continueRequired: 'LimCode 已暂停，可继续处理。'
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
    this.adapter = options.adapter ?? new NodeNotifierWindowsToastAdapter()
    this.platform = options.platform ?? process.platform
    this.getWindowState = options.getWindowState ?? (() => vscode.window.state)
    this.onDidChangeWindowState = options.onDidChangeWindowState ?? vscode.window.onDidChangeWindowState
    this.executeCommand = options.executeCommand ?? ((command: string) => vscode.commands.executeCommand(command))
    this.logger = options.logger ?? console
    this.dedupeTtlMs = options.dedupeTtlMs ?? 5 * 60 * 1000
    this.settingsManager = options.settingsManager

    this.windowFocused = !!this.getWindowState().focused
    console.log(LOG_PREFIX, 'service initialized', {
      platform: this.platform,
      windowFocused: this.windowFocused
    })

    this.windowStateDisposable = this.onDidChangeWindowState((state) => {
      this.windowFocused = !!state.focused
      console.log(LOG_PREFIX, 'window focus changed', {
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
    return settings.cases.continueRequired
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
      default:
        return t('notifications.windowsAgentStop.reasonLabels.continueRequired')
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
    return content.bodyTemplates.continueRequired
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
      console.log(LOG_PREFIX, 'handling notification click by executing limcode.openChat')
      await this.executeCommand('limcode.openChat')
      console.log(LOG_PREFIX, 'limcode.openChat executed successfully')
    } catch (error) {
      this.logger.error('[windows-agent-stop-notification] Failed to focus chat view:', error)
    }
  }

  private async showToast(title: string, message: string): Promise<AgentStopNotificationDispatchResult> {
    console.log(LOG_PREFIX, 'showToast invoked', {
      title,
      message,
      windowFocused: this.windowFocused
    })

    const toastResult = await this.adapter.show({
      title,
      message,
      silent: true,
      waitForAction: true,
      onClick: () => this.handleNotificationClick()
    })

    if (!toastResult.shown) {
      console.log(LOG_PREFIX, 'toast adapter reported not shown', toastResult)

      if (toastResult.error) {
        this.logger.warn('[windows-agent-stop-notification] Failed to show toast:', toastResult.error)
      }

      return {
        shown: false,
        skipped: true,
        reason: toastResult.skippedReason || (toastResult.error ? 'adapter_error' : 'not_shown')
      }
    }

    console.log(LOG_PREFIX, 'toast adapter reported success')

    return {
      shown: true,
      skipped: false
    }
  }

  async notify(payload: AgentStopNotificationPayload): Promise<AgentStopNotificationDispatchResult> {
    const now = Date.now()
    this.cleanupExpiredDedupes(now)

    console.log(LOG_PREFIX, 'notify called', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      conversationId: payload.conversationId,
      actionType: payload.actionType,
      windowFocused: this.windowFocused
    })

    if (this.platform !== 'win32') {
      console.log(LOG_PREFIX, 'skip notify because platform is not win32', { platform: this.platform })
      return {
        shown: false,
        skipped: true,
        reason: 'unsupported_platform'
      }
    }

    const settings = this.getSettings()
    console.log(LOG_PREFIX, 'resolved host notification settings', settings)

    if (!settings.enabled) {
      console.log(LOG_PREFIX, 'skip notify because feature is disabled in settings')
      return {
        shown: false,
        skipped: true,
        reason: 'disabled'
      }
    }

    if (!this.isReasonEnabled(payload.reason, settings)) {
      console.log(LOG_PREFIX, 'skip notify because reason is disabled in settings', {
        reason: payload.reason
      })
      return {
        shown: false,
        skipped: true,
        reason: 'case_disabled'
      }
    }

    if (settings.onlyWhenWindowNotFocused && this.windowFocused) {
      console.log(LOG_PREFIX, 'skip notify because originating window is focused')
      return {
        shown: false,
        skipped: true,
        reason: 'window_focused'
      }
    }

    const dedupeKey = normalizeText(payload.dedupeKey)
    if (!dedupeKey) {
      console.log(LOG_PREFIX, 'skip notify because dedupeKey is missing')
      return {
        shown: false,
        skipped: true,
        reason: 'missing_dedupe_key'
      }
    }

    if (this.isDuplicate(dedupeKey)) {
      console.log(LOG_PREFIX, 'skip notify because dedupeKey is duplicated', {
        dedupeKey
      })
      return {
        shown: false,
        skipped: true,
        reason: 'duplicate'
      }
    }

    const rendered = this.buildRenderedNotification(payload.reason, settings.content, {
      actionType: payload.actionType,
      actionLabel: payload.actionLabel
    })
    console.log(LOG_PREFIX, 'rendered notification content', {
      reason: payload.reason,
      title: rendered.title,
      message: rendered.message,
      windowTitle: rendered.windowTitle,
      reasonLabel: rendered.reasonLabel,
      actionLabel: rendered.actionLabel
    })

    const result = await this.showToast(rendered.title, rendered.message)
    if (!result.shown) {
      console.log(LOG_PREFIX, 'notify finished without showing toast', result)
      return result
    }

    this.rememberDedupe(dedupeKey, now)
    console.log(LOG_PREFIX, 'remembered dedupeKey after successful toast', {
      dedupeKey,
      storedAt: now
    })

    return result
  }

  async preview(payload: WindowsNotificationPreviewPayload): Promise<AgentStopNotificationDispatchResult> {
    console.log(LOG_PREFIX, 'preview called', {
      reason: payload.reason,
      actionType: payload.actionType,
      hasContentOverride: !!payload.content,
      windowFocused: this.windowFocused
    })

    if (this.platform !== 'win32') {
      console.log(LOG_PREFIX, 'skip preview because platform is not win32', { platform: this.platform })
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

    console.log(LOG_PREFIX, 'rendered preview content', {
      reason: payload.reason,
      title: rendered.title,
      message: rendered.message,
      windowTitle: rendered.windowTitle,
      reasonLabel: rendered.reasonLabel,
      actionLabel: rendered.actionLabel
    })

    const result = await this.showToast(rendered.title, rendered.message)
    console.log(LOG_PREFIX, 'preview finished', result)
    return result
  }

  dispose(): void {
    this.windowStateDisposable?.dispose()
    this.windowStateDisposable = undefined
    this.dedupeByKey.clear()
    console.log(LOG_PREFIX, 'service disposed')
  }
}
