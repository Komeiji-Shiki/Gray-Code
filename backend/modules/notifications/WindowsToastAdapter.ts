import * as vscode from 'vscode'
import type { WindowsToastAdapter, WindowsToastRequest, WindowsToastShowResult } from './types'

const LOG_PREFIX = '[windows-agent-stop-notification][toast]'

const DEFAULT_VSCODE_WINDOWS_APP_ID = 'Microsoft.VisualStudioCode'

function resolveVSCodeWindowsToastAppId(): string {
  const appName = typeof vscode.env.appName === 'string' ? vscode.env.appName.trim() : ''
  const uriScheme = typeof vscode.env.uriScheme === 'string' ? vscode.env.uriScheme.trim().toLowerCase() : ''

  if (uriScheme === 'vscode-insiders' || /insiders/i.test(appName)) {
    return 'Microsoft.VisualStudioCode.Insiders'
  }

  return DEFAULT_VSCODE_WINDOWS_APP_ID
}

type WindowsToasterLike = {
  notify: (
    options: Record<string, unknown>,
    callback?: (error: Error | null, response?: string, metadata?: unknown) => void
  ) => void
  once: (eventName: string, listener: (...args: any[]) => void) => void
  removeListener: (eventName: string, listener: (...args: any[]) => void) => void
}

export type WindowsToasterFactory = () => WindowsToasterLike

function defaultCreateWindowsToaster(): WindowsToasterLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const notifier = require('node-notifier')
  const WindowsToaster = notifier?.WindowsToaster || notifier
  return new WindowsToaster({ withFallback: false })
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Unknown Windows toast error'
}

export class NodeNotifierWindowsToastAdapter implements WindowsToastAdapter {
  constructor(
    private readonly createWindowsToaster: WindowsToasterFactory = defaultCreateWindowsToaster,
    private readonly logger: Pick<Console, 'error'> = console,
    private readonly cleanupDelayMs = 5 * 60 * 1000,
    private readonly appId: string = resolveVSCodeWindowsToastAppId()
  ) {}

  async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
    console.log(LOG_PREFIX, 'show called', {
      title: request.title,
      message: request.message,
      silent: request.silent,
      waitForAction: request.waitForAction,
      hasOnClick: typeof request.onClick === 'function',
      appId: this.appId
    })

    if (process.platform !== 'win32') {
      console.log(LOG_PREFIX, 'skip show because platform is not win32', { platform: process.platform })
      return {
        shown: false,
        skippedReason: 'unsupported_platform'
      }
    }

    let toaster: WindowsToasterLike
    try {
      toaster = this.createWindowsToaster()
      console.log(LOG_PREFIX, 'created Windows toaster instance')
    } catch (error) {
      console.error(LOG_PREFIX, 'failed to create Windows toaster instance', error)
      return {
        shown: false,
        error: toErrorMessage(error)
      }
    }

    return await new Promise<WindowsToastShowResult>((resolve) => {
      let cleaned = false
      let cleanupTimer: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (cleaned) return
        cleaned = true

        if (cleanupTimer) {
          clearTimeout(cleanupTimer)
          cleanupTimer = null
        }

        try {
          toaster.removeListener('click', handleClick)
          toaster.removeListener('timeout', handleTimeout)
          toaster.removeListener('replied', handleReply)
        } catch {
          // ignore cleanup failures
        }
      }

      const handleClick = () => {
        console.log(LOG_PREFIX, 'toast click event received')
        void Promise.resolve(request.onClick?.()).catch((error) => {
          this.logger.error('[windows-toast] Failed to handle click:', error)
        }).finally(() => {
          cleanup()
        })
      }

      const handleTimeout = () => {
        console.log(LOG_PREFIX, 'toast timeout event received')
        cleanup()
      }

      const handleReply = () => {
        console.log(LOG_PREFIX, 'toast replied event received')
        cleanup()
      }

      if (request.onClick) {
        toaster.once('click', handleClick)
      }
      toaster.once('timeout', handleTimeout)
      toaster.once('replied', handleReply)
      cleanupTimer = setTimeout(cleanup, this.cleanupDelayMs)

      try {
        console.log(LOG_PREFIX, 'calling toaster.notify')
        toaster.notify(
          {
            title: request.title,
            message: request.message,
            sound: request.silent ? false : true,
            wait: request.waitForAction,
            appID: this.appId
          },
          (error, response, metadata) => {
            if (error) {
              console.error(LOG_PREFIX, 'toaster.notify callback returned error', error)
              cleanup()
              resolve({
                shown: false,
                error: toErrorMessage(error)
              })
              return
            }

            console.log(LOG_PREFIX, 'toaster.notify callback reported success', {
              response,
              metadata
            })

            resolve({ shown: true })

            if (!request.waitForAction && !request.onClick) {
              cleanup()
            }
          }
        )
      } catch (error) {
        console.error(LOG_PREFIX, 'toaster.notify threw synchronously', error)
        cleanup()
        resolve({
          shown: false,
          error: toErrorMessage(error)
        })
      }
    })
  }
}
