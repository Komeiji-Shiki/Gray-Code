import { nextTick, watch, type WatchStopHandle } from 'vue'
import type { ErrorInfo, Message, ToolUsage } from '../types'
import { getSoundSettings, type NormalizedUISoundSettings } from './soundCues'
import {
  resolvePendingAgentAction,
  type PendingAgentAction,
  type PendingAgentActionType
} from '../utils/pendingAgentAction'

// 生命周期调试日志开关：默认关闭，DevTools 控制台执行
// localStorage.setItem('graycode.debug', '1') 后重新初始化可见。
function dbg(...args: unknown[]): void {
  try {
    if (localStorage.getItem('graycode.debug') !== '1') return
  } catch {
    return
  }
  // eslint-disable-next-line no-console
  console.debug(...args)
}

export type AgentStopNotificationReason = 'error' | 'awaiting_user_action' | 'continue_required'

export interface AgentStopNotificationPayload {
  reason: AgentStopNotificationReason
  dedupeKey: string
  createdAt: number
  conversationId?: string
  actionType?: PendingAgentActionType
  toolName?: string
  toolId?: string
  path?: string
  errorCode?: string
}

export interface AgentStopNotificationControllerChatStore {
  isStreaming: boolean
  isWaitingForResponse: boolean
  error: ErrorInfo | null
  retryStatus?: { isRetrying?: boolean } | null
  needsContinueButton: boolean
  hasPendingToolConfirmation: boolean
  pendingToolCalls: ToolUsage[]
  allMessages: Message[]
  currentConversationId: string | null
  currentConversation?: { title?: string } | null
}

export interface AgentStopNotificationControllerOptions {
  chatStore: AgentStopNotificationControllerChatStore
  sendToExtension: <T = any>(type: string, data: any) => Promise<T>
  getSoundSettings?: () => NormalizedUISoundSettings
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function findLatestMessage(messages: Message[], predicate?: (message: Message) => boolean): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (!predicate || predicate(message)) {
      return message
    }
  }
  return null
}

export class AgentStopNotificationController {
  private readonly chatStore: AgentStopNotificationControllerChatStore
  private readonly sendToExtension: <T = any>(type: string, data: any) => Promise<T>
  private readonly getRuntimeSoundSettings: () => NormalizedUISoundSettings
  private runningWatch?: WatchStopHandle
  private suppressNextStop = false
  private lastSentDedupeKey = ''

  constructor(options: AgentStopNotificationControllerOptions) {
    this.chatStore = options.chatStore
    this.sendToExtension = options.sendToExtension
    this.getRuntimeSoundSettings = options.getSoundSettings ?? getSoundSettings
    dbg( 'controller initialized')

    this.runningWatch = watch(
      () => this.isAgentRunning(),
      (isRunning, wasRunning) => {
        dbg( 'running state changed', {
          wasRunning,
          isRunning,
          isStreaming: this.chatStore.isStreaming,
          isWaitingForResponse: this.chatStore.isWaitingForResponse,
          hasError: !!this.chatStore.error,
          isRetrying: !!this.chatStore.retryStatus?.isRetrying,
          needsContinueButton: this.chatStore.needsContinueButton,
          hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation
        })

        if (isRunning) {
          this.lastSentDedupeKey = ''
          // 新一轮开始：清除上一轮用户取消遗留的 suppressNextStop，
          // 避免“取消后立即发送新消息”时新一轮正常结束的 stop 被误判为用户取消而吞掉通知
          this.suppressNextStop = false
          dbg( 'agent entered running state, reset last dedupe key')
          return
        }

        if (wasRunning) {
          void this.handleAgentStopped().catch(error => {
            console.error('[agent-stop-notification] Failed to handle stopped agent:', error)
          })
        }
      },
      {
        flush: 'post'
      }
    )
  }

  markUserCancelled(): void {
    if (!this.isAgentRunning()) {
      dbg( 'markUserCancelled ignored because agent is not running')
      return
    }

    this.suppressNextStop = true
    dbg( 'marked next stop as user-cancelled')
  }

  clearUserCancelled(): void {
    this.suppressNextStop = false
    dbg( 'cleared user-cancel suppression flag')
  }

  dispose(): void {
    this.runningWatch?.()
    this.runningWatch = undefined
    this.suppressNextStop = false
    this.lastSentDedupeKey = ''
    dbg( 'controller disposed')
  }

  private isAgentRunning(): boolean {
    return !!(this.chatStore.isStreaming || this.chatStore.isWaitingForResponse)
  }

  private getNotificationSettings() {
    return this.getRuntimeSoundSettings().windowsAgentStopNotification
  }

  private shouldNotify(reason: AgentStopNotificationReason): boolean {
    const settings = this.getNotificationSettings()

    if (!settings.enabled) {
      dbg( 'skip notify because Windows notifications are disabled', {
        reason,
        settings
      })
      return false
    }

    const enabled = reason === 'error'
      ? settings.cases.error
      : reason === 'awaiting_user_action'
        ? settings.cases.awaitingUserAction
        : settings.cases.continueRequired

    if (!enabled) {
      dbg( 'skip notify because notification case is disabled', {
        reason,
        settings
      })
    }

    return enabled
  }

  private getCreatedAt(preferredMessage: Message | null): number {
    if (preferredMessage && Number.isFinite(preferredMessage.timestamp)) {
      return preferredMessage.timestamp
    }

    const latestMessage = findLatestMessage(this.chatStore.allMessages)
    if (latestMessage && Number.isFinite(latestMessage.timestamp)) {
      return latestMessage.timestamp
    }

    return Date.now()
  }

  private buildErrorPayload(): AgentStopNotificationPayload | null {
    const error = this.chatStore.error
    if (!error || !this.shouldNotify('error')) {
      return null
    }

    const conversationId = this.chatStore.currentConversationId || undefined
    const latestMessage = findLatestMessage(this.chatStore.allMessages)
    const messageKey = latestMessage?.id || String(latestMessage?.backendIndex || '')

    const payload: AgentStopNotificationPayload = {
      reason: 'error',
      dedupeKey: ['error', conversationId || '', error.code || '', error.message || '', messageKey].join(':'),
      createdAt: this.getCreatedAt(latestMessage),
      conversationId,
      errorCode: normalizeText(error.code)
    }

    dbg( 'built error payload', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      errorCode: payload.errorCode,
      conversationId: payload.conversationId
    })
    return payload
  }

  private buildAwaitingUserActionPayload(action: PendingAgentAction): AgentStopNotificationPayload | null {
    if (!this.shouldNotify('awaiting_user_action')) {
      return null
    }

    const latestMessage = findLatestMessage(this.chatStore.allMessages)

    const payload: AgentStopNotificationPayload = {
      reason: 'awaiting_user_action',
      dedupeKey: action.actionKey,
      createdAt: this.getCreatedAt(latestMessage),
      conversationId: action.conversationId || this.chatStore.currentConversationId || undefined,
      actionType: action.type,
      toolName: action.toolName,
      toolId: action.toolId,
      path: action.path
    }

    dbg( 'built awaiting_user_action payload', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      actionType: payload.actionType,
      toolName: payload.toolName,
      path: payload.path
    })
    return payload
  }

  private buildContinueRequiredPayload(): AgentStopNotificationPayload | null {
    if (!this.chatStore.needsContinueButton || !this.shouldNotify('continue_required')) {
      return null
    }

    const conversationId = this.chatStore.currentConversationId || undefined
    const latestFunctionResponse = findLatestMessage(this.chatStore.allMessages, (message) => message.isFunctionResponse === true)
    const latestMessage = latestFunctionResponse || findLatestMessage(this.chatStore.allMessages)
    const dedupeSource = latestFunctionResponse?.id || String(latestFunctionResponse?.backendIndex || latestMessage?.id || '')

    const payload: AgentStopNotificationPayload = {
      reason: 'continue_required',
      dedupeKey: ['continue_required', conversationId || '', dedupeSource].join(':'),
      createdAt: this.getCreatedAt(latestMessage),
      conversationId,
      actionType: 'continue'
    }

    dbg( 'built continue_required payload', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      actionType: payload.actionType,
      conversationId: payload.conversationId
    })
    return payload
  }

  private buildPayload(): AgentStopNotificationPayload | null {
    if (this.chatStore.retryStatus?.isRetrying) {
      dbg( 'skip notification because retrying is active')
      return null
    }

    const errorPayload = this.buildErrorPayload()
    if (errorPayload) {
      dbg( 'selected error payload')
      return errorPayload
    }

    const pendingAction = resolvePendingAgentAction({
      allMessages: this.chatStore.allMessages,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation,
      pendingToolCalls: this.chatStore.pendingToolCalls,
      conversationId: this.chatStore.currentConversationId
    })

    dbg( 'resolved pending action', pendingAction)

    if (pendingAction) {
      const payload = this.buildAwaitingUserActionPayload(pendingAction)
      if (payload) {
        dbg( 'selected awaiting_user_action payload')
      }
      return payload
    }

    const continuePayload = this.buildContinueRequiredPayload()
    if (continuePayload) {
      dbg( 'selected continue_required payload')
      return continuePayload
    }

    dbg( 'no notification payload matched current stop state', {
      hasError: !!this.chatStore.error,
      needsContinueButton: this.chatStore.needsContinueButton,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation,
      messages: this.chatStore.allMessages.length
    })

    return null
  }

  private async handleAgentStopped(): Promise<void> {
    await nextTick()
    await Promise.resolve()

    dbg( 'handling agent stopped event after state settled', {
      isStreaming: this.chatStore.isStreaming,
      isWaitingForResponse: this.chatStore.isWaitingForResponse,
      hasError: !!this.chatStore.error,
      isRetrying: !!this.chatStore.retryStatus?.isRetrying,
      needsContinueButton: this.chatStore.needsContinueButton,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation
    })

    if (this.isAgentRunning()) {
      dbg( 'stop handling aborted because agent resumed running')
      return
    }

    if (this.suppressNextStop) {
      this.suppressNextStop = false
      dbg( 'skip notification because stop was marked as user-cancelled')
      return
    }

    const payload = this.buildPayload()
    if (!payload) {
      dbg( 'skip notification because no payload was produced')
      return
    }

    if (payload.dedupeKey === this.lastSentDedupeKey) {
      dbg( 'skip notification because dedupe key already sent in current stop cycle', {
        dedupeKey: payload.dedupeKey
      })
      return
    }

    this.lastSentDedupeKey = payload.dedupeKey

    try {
      dbg( 'sending notification payload to extension', payload)
      const result = await this.sendToExtension('notifications.agentStop', payload)
      dbg( 'extension responded to notification payload', result)
    } catch (error) {
      console.error('[agent-stop-notification] Failed to send notification payload:', error)
    }
  }
}

export function createAgentStopNotificationController(
  options: AgentStopNotificationControllerOptions
): AgentStopNotificationController {
  return new AgentStopNotificationController(options)
}
