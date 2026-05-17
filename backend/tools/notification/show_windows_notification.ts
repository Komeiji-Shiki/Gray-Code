import * as vscode from 'vscode'
import type { Tool, ToolDeclaration, ToolResult } from '../types'
import { NodeNotifierWindowsToastAdapter } from '../../modules/notifications/WindowsToastAdapter'
import type { WindowsToastAdapter } from '../../modules/notifications/types'

const DEFAULT_TITLE = 'LimCode'
const MAX_TITLE_LENGTH = 120
const MAX_MESSAGE_LENGTH = 1000

export interface ShowWindowsNotificationArgs {
  title: string
  message: string
  silent?: boolean
  openChatOnClick?: boolean
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`
}

function toToolResultError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Unknown notification error'
}

export function createShowWindowsNotificationToolDeclaration(): ToolDeclaration {
  return {
    name: 'show_windows_notification',
    strict: true,
    category: 'notification',
    description: 'Show a Windows system notification with a custom title and message. Use this when you need to notify the user outside the chat UI, for example when a long task finishes, user action is needed, or an important status changes. On non-Windows platforms the tool reports that notification is unsupported.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title. Keep it short and clear.'
        },
        message: {
          type: 'string',
          description: 'Notification body text. Summarize the important information for the user.'
        },
        silent: {
          type: 'boolean',
          description: 'Whether to suppress notification sound. Default: true.'
        },
        openChatOnClick: {
          type: 'boolean',
          description: 'Whether clicking the notification should open the LimCode chat view. Default: true.'
        }
      },
      required: ['title', 'message']
    }
  }
}

export function createShowWindowsNotificationTool(
  adapter: WindowsToastAdapter = new NodeNotifierWindowsToastAdapter(),
  platform: NodeJS.Platform = process.platform,
  executeCommand: (command: string) => Promise<unknown> | Thenable<unknown> = command => vscode.commands.executeCommand(command)
): Tool {
  return {
    declaration: createShowWindowsNotificationToolDeclaration(),
    handler: async (args): Promise<ToolResult> => {
      if (platform !== 'win32') {
        return {
          success: false,
          error: `Windows system notifications are only supported on Windows. Current platform: ${platform}`,
          data: {
            shown: false,
            skippedReason: 'unsupported_platform',
            platform
          }
        }
      }

      const title = normalizeText(args.title, MAX_TITLE_LENGTH) || DEFAULT_TITLE
      const message = normalizeText(args.message, MAX_MESSAGE_LENGTH)
      if (!message) {
        return {
          success: false,
          error: 'message must be a non-empty string'
        }
      }

      const silent = args.silent !== false
      const openChatOnClick = args.openChatOnClick !== false

      try {
        const result = await adapter.show({
          title,
          message,
          silent,
          waitForAction: openChatOnClick,
          onClick: openChatOnClick
            ? async () => {
                await executeCommand('limcode.openChat')
              }
            : undefined
        })

        if (!result.shown) {
          return {
            success: false,
            error: result.error || result.skippedReason || 'Notification was not shown',
            data: {
              shown: false,
              skippedReason: result.skippedReason,
              title,
              message
            }
          }
        }

        return {
          success: true,
          data: {
            shown: true,
            title,
            message,
            silent,
            openChatOnClick
          }
        }
      } catch (error) {
        return {
          success: false,
          error: toToolResultError(error)
        }
      }
    }
  }
}

export function registerShowWindowsNotification(): Tool {
  return createShowWindowsNotificationTool()
}
