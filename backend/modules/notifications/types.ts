export type AgentStopNotificationReason = 'error' | 'awaiting_user_action' | 'continue_required'

export type PendingAgentActionType = 'generate_plan' | 'execute_plan' | 'continue' | 'generic_confirmation'

export interface WindowsAgentStopNotificationContentOverride {
  titleTemplate?: string
  bodyTemplates?: {
    error?: string
    awaitingUserAction?: string
    continueRequired?: string
  }
}

export interface AgentStopNotificationPayload {
  reason: AgentStopNotificationReason
  dedupeKey: string
  createdAt: number
  title?: string
  message?: string
  conversationId?: string
  conversationTitle?: string
  actionType?: PendingAgentActionType
  actionLabel?: string
  toolName?: string
  toolId?: string
  path?: string
  errorCode?: string
  errorMessage?: string
}

export interface WindowsNotificationPreviewPayload {
  reason: AgentStopNotificationReason
  actionType?: PendingAgentActionType
  actionLabel?: string
  content?: WindowsAgentStopNotificationContentOverride
}

export interface WindowsToastRequest {
  title: string
  message: string
  silent: boolean
  waitForAction: boolean
  onClick?: () => void | Promise<void>
  /** 异步失败回调：通知 API 异步 reject（无法在 show() 返回前感知）时通知调用方，
   *  供服务侧回滚去重键等状态。 */
  onError?: (error: unknown) => void
}

export interface WindowsToastShowResult {
  shown: boolean
  skippedReason?: string
  error?: string
}

export interface WindowsToastAdapter {
  show(request: WindowsToastRequest): Promise<WindowsToastShowResult>
}

export interface AgentStopNotificationDispatchResult {
  shown: boolean
  skipped: boolean
  reason?: string
}
