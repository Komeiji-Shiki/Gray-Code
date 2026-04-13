import type {
  AgentStopNotificationPayload,
  PendingAgentActionType,
  WindowsNotificationPreviewPayload
} from '../../backend/modules/notifications/types'
import type { MessageHandler } from '../types'

const LOG_PREFIX = '[windows-agent-stop-notification][handler]'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeReason(value: unknown): AgentStopNotificationPayload['reason'] | undefined {
  if (value === 'error' || value === 'awaiting_user_action' || value === 'continue_required') {
    return value
  }
  return undefined
}

function normalizeActionType(value: unknown): PendingAgentActionType | undefined {
  if (
    value === 'generate_plan'
    || value === 'execute_plan'
    || value === 'continue'
    || value === 'generic_confirmation'
  ) {
    return value
  }
  return undefined
}

function normalizePayload(data: unknown): AgentStopNotificationPayload | null {
  const record = asRecord(data)
  if (!record) return null

  const reason = normalizeReason(record.reason)
  const dedupeKey = normalizeString(record.dedupeKey)
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now()

  if (!reason || !dedupeKey) {
    return null
  }

  return {
    reason,
    dedupeKey,
    createdAt,
    title: normalizeString(record.title),
    message: normalizeString(record.message),
    conversationId: normalizeString(record.conversationId),
    conversationTitle: normalizeString(record.conversationTitle),
    actionType: normalizeActionType(record.actionType),
    actionLabel: normalizeString(record.actionLabel),
    toolName: normalizeString(record.toolName),
    toolId: normalizeString(record.toolId),
    path: normalizeString(record.path),
    errorCode: normalizeString(record.errorCode),
    errorMessage: normalizeString(record.errorMessage)
  }
}

function normalizeContentOverride(value: unknown): WindowsNotificationPreviewPayload['content'] | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const bodyTemplates = asRecord(record.bodyTemplates)
  const normalizedBodyTemplates = {
    error: normalizeString(bodyTemplates?.error),
    awaitingUserAction: normalizeString(bodyTemplates?.awaitingUserAction),
    continueRequired: normalizeString(bodyTemplates?.continueRequired)
  }

  const hasBodyTemplate = !!(
    normalizedBodyTemplates.error
    || normalizedBodyTemplates.awaitingUserAction
    || normalizedBodyTemplates.continueRequired
  )

  const titleTemplate = normalizeString(record.titleTemplate)
  if (!titleTemplate && !hasBodyTemplate) {
    return undefined
  }

  return {
    titleTemplate,
    bodyTemplates: hasBodyTemplate ? normalizedBodyTemplates : undefined
  }
}

function normalizePreviewPayload(data: unknown): WindowsNotificationPreviewPayload | null {
  const record = asRecord(data)
  if (!record) return null

  const reason = normalizeReason(record.reason)
  if (!reason) return null

  return {
    reason,
    actionType: normalizeActionType(record.actionType),
    actionLabel: normalizeString(record.actionLabel),
    content: normalizeContentOverride(record.content)
  }
}

export const notifyAgentStop: MessageHandler = async (data, requestId, ctx) => {
  const payload = normalizePayload(data)
  if (!payload) {
    console.log(LOG_PREFIX, 'invalid notifications.agentStop payload', data)
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'invalid_payload'
    })
    return
  }

  if (!ctx.windowsAgentStopNotificationService) {
    console.log(LOG_PREFIX, 'notifications.agentStop skipped because service is unavailable')
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'service_unavailable'
    })
    return
  }

  try {
    console.log(LOG_PREFIX, 'dispatching notifications.agentStop', payload)
    const result = await ctx.windowsAgentStopNotificationService.notify(payload)
    console.log(LOG_PREFIX, 'notifications.agentStop finished', {
      payload,
      result
    })
    ctx.sendResponse(requestId, {
      success: true,
      ...result
    })
  } catch (error) {
    console.error('[notifications.agentStop] Failed to dispatch notification:', error)
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'handler_error'
    })
  }
}

export const previewWindowsNotification: MessageHandler = async (data, requestId, ctx) => {
  const payload = normalizePreviewPayload(data)
  if (!payload) {
    console.log(LOG_PREFIX, 'invalid notifications.preview payload', data)
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'invalid_payload'
    })
    return
  }

  if (!ctx.windowsAgentStopNotificationService) {
    console.log(LOG_PREFIX, 'notifications.preview skipped because service is unavailable')
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'service_unavailable'
    })
    return
  }

  try {
    console.log(LOG_PREFIX, 'dispatching notifications.preview', payload)
    const result = await ctx.windowsAgentStopNotificationService.preview(payload)
    console.log(LOG_PREFIX, 'notifications.preview finished', {
      payload,
      result
    })
    ctx.sendResponse(requestId, {
      success: true,
      ...result
    })
  } catch (error) {
    console.error('[notifications.preview] Failed to dispatch preview notification:', error)
    ctx.sendResponse(requestId, {
      success: true,
      shown: false,
      skipped: true,
      reason: 'handler_error'
    })
  }
}

export function registerNotificationHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('notifications.agentStop', notifyAgentStop)
  registry.set('notifications.preview', previewWindowsNotification)
}
