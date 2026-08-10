import { nextTick, watch, type WatchStopHandle } from 'vue'
import type { ErrorInfo, Message, ToolUsage } from '../types'
import { getSoundSettings, type NormalizedUISoundSettings } from './soundCues'
import {
  resolvePendingAgentAction,
  type PendingAgentAction,
  type PendingAgentActionType
} from '../utils/pendingAgentAction'

// 说明：本控制器所有过程日志统一使用 console.debug（而非 console.log）——
// 每次 agent 回合结束都会经过这里输出多条日志，log 级别会在控制台刷屏；
// debug 级别默认隐藏，需要排查时再开启 verbose 输出。错误路径仍用 console.error。
const LOG_PREFIX = '[agent-stop-notification][frontend]'

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
  /** dispose 后置位：进行中的 handleAgentStopped 在发送前检查，避免已销毁控制器继续发通知 */
  private disposed = false
  /** 用户最近一次取消请求时刻：nextTick 窗口内的取消点击（agent 已停止时）也据此抑制通知 */
  private lastUserCancelAt = 0

  constructor(options: AgentStopNotificationControllerOptions) {
    this.chatStore = options.chatStore
    this.sendToExtension = options.sendToExtension
    this.getRuntimeSoundSettings = options.getSoundSettings ?? getSoundSettings
    console.debug(LOG_PREFIX, 'controller initialized')

    this.runningWatch = watch(
      () => this.isAgentRunning(),
      (isRunning, wasRunning) => {
        console.debug(LOG_PREFIX, 'running state changed', {
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
          // 新一轮开始：清除上一轮用户取消遗留的 suppressNextStop 与取消时刻戳，
          // 避免“取消后立即发送新消息”时新一轮正常结束的 stop 被误判为用户取消而吞掉通知
          this.suppressNextStop = false
          this.lastUserCancelAt = 0
          console.debug(LOG_PREFIX, 'agent entered running state, reset last dedupe key')
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
    // 无论 agent 是否仍在运行都记录取消时刻：handleAgentStopped 的 nextTick 窗口内
    // 用户点击取消时 isAgentRunning() 可能已为 false（suppressNextStop 无法置位），
    // 此时依据“取消时刻晚于本次 stop 周期起点”同样抑制通知（见 handleAgentStopped）
    this.lastUserCancelAt = Date.now()
    if (!this.isAgentRunning()) {
      console.debug(LOG_PREFIX, 'markUserCancelled ignored because agent is not running')
      return
    }

    this.suppressNextStop = true
    console.debug(LOG_PREFIX, 'marked next stop as user-cancelled')
  }

  clearUserCancelled(): void {
    this.suppressNextStop = false
    console.debug(LOG_PREFIX, 'cleared user-cancel suppression flag')
  }

  dispose(): void {
    this.disposed = true
    this.runningWatch?.()
    this.runningWatch = undefined
    this.suppressNextStop = false
    this.lastSentDedupeKey = ''
    this.lastUserCancelAt = 0
    console.debug(LOG_PREFIX, 'controller disposed')
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
      console.debug(LOG_PREFIX, 'skip notify because Windows notifications are disabled', {
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
      console.debug(LOG_PREFIX, 'skip notify because notification case is disabled', {
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

    console.debug(LOG_PREFIX, 'built error payload', {
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

    console.debug(LOG_PREFIX, 'built awaiting_user_action payload', {
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

    console.debug(LOG_PREFIX, 'built continue_required payload', {
      reason: payload.reason,
      dedupeKey: payload.dedupeKey,
      actionType: payload.actionType,
      conversationId: payload.conversationId
    })
    return payload
  }

  private buildPayload(): AgentStopNotificationPayload | null {
    if (this.chatStore.retryStatus?.isRetrying) {
      console.debug(LOG_PREFIX, 'skip notification because retrying is active')
      return null
    }

    const errorPayload = this.buildErrorPayload()
    if (errorPayload) {
      console.debug(LOG_PREFIX, 'selected error payload')
      return errorPayload
    }

    const pendingAction = resolvePendingAgentAction({
      allMessages: this.chatStore.allMessages,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation,
      pendingToolCalls: this.chatStore.pendingToolCalls,
      conversationId: this.chatStore.currentConversationId
    })

    console.debug(LOG_PREFIX, 'resolved pending action', pendingAction)

    if (pendingAction) {
      const payload = this.buildAwaitingUserActionPayload(pendingAction)
      if (payload) {
        console.debug(LOG_PREFIX, 'selected awaiting_user_action payload')
      }
      return payload
    }

    const continuePayload = this.buildContinueRequiredPayload()
    if (continuePayload) {
      console.debug(LOG_PREFIX, 'selected continue_required payload')
      return continuePayload
    }

    console.debug(LOG_PREFIX, 'no notification payload matched current stop state', {
      hasError: !!this.chatStore.error,
      needsContinueButton: this.chatStore.needsContinueButton,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation,
      messages: this.chatStore.allMessages.length
    })

    return null
  }

  private async handleAgentStopped(): Promise<void> {
    if (this.disposed) return
    // 本次 stop 周期起点：nextTick 窗口内（用户取消点击晚于该时刻）用于取消竞态校验
    const stopCycleStartedAt = Date.now()
    await nextTick()
    await Promise.resolve()

    // dispose 后不再继续处理（不等待进行中任务）
    if (this.disposed) return

    console.debug(LOG_PREFIX, 'handling agent stopped event after state settled', {
      isStreaming: this.chatStore.isStreaming,
      isWaitingForResponse: this.chatStore.isWaitingForResponse,
      hasError: !!this.chatStore.error,
      isRetrying: !!this.chatStore.retryStatus?.isRetrying,
      needsContinueButton: this.chatStore.needsContinueButton,
      hasPendingToolConfirmation: this.chatStore.hasPendingToolConfirmation
    })

    if (this.isAgentRunning()) {
      console.debug(LOG_PREFIX, 'stop handling aborted because agent resumed running')
      return
    }

    // nextTick 窗口竞态再校验：窗口内用户点击取消时 markUserCancelled 可能因 agent 已停止
    // 而未置位 suppressNextStop（仅记录了 lastUserCancelAt），此处按取消时刻一并抑制
    if (this.suppressNextStop || this.lastUserCancelAt > stopCycleStartedAt) {
      this.suppressNextStop = false
      console.debug(LOG_PREFIX, 'skip notification because stop was marked as user-cancelled')
      return
    }

    const payload = this.buildPayload()
    if (!payload) {
      console.debug(LOG_PREFIX, 'skip notification because no payload was produced')
      return
    }

    if (payload.dedupeKey === this.lastSentDedupeKey) {
      console.debug(LOG_PREFIX, 'skip notification because dedupe key already sent in current stop cycle', {
        dedupeKey: payload.dedupeKey
      })
      return
    }

    this.lastSentDedupeKey = payload.dedupeKey

    try {
      // 发送前再校验一次：dispose 后不再发起新的通知请求
      if (this.disposed) return
      console.debug(LOG_PREFIX, 'sending notification payload to extension', payload)
      const result = await this.sendToExtension('notifications.agentStop', payload)
      console.debug(LOG_PREFIX, 'extension responded to notification payload', result)
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
