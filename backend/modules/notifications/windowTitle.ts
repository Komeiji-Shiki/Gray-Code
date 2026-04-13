import * as path from 'path'
import * as vscode from 'vscode'
import { t } from '../../i18n'

interface WorkspaceLike {
  workspaceFile?: { fsPath: string } | null
  workspaceFolders?: Array<{
    name?: string
    uri: { fsPath: string }
  }>
}

interface WindowLike {
  activeTextEditor?: {
    document?: {
      uri?: {
        fsPath?: string
      }
    }
  } | null
}

export interface DeriveWindowsAgentStopWindowTitleOptions {
  workspace?: WorkspaceLike
  window?: WindowLike
  basename?: (value: string) => string
}

function basenameOrUndefined(value: string | undefined, basename: (value: string) => string): string | undefined {
  if (!value) {
    return undefined
  }

  const name = basename(value).trim()
  return name || undefined
}

export function deriveWindowsAgentStopWindowTitle(
  options: DeriveWindowsAgentStopWindowTitleOptions = {}
): string {
  const workspace = options.workspace ?? vscode.workspace
  const window = options.window ?? vscode.window
  const basename = options.basename ?? path.basename

  const workspaceFileName = basenameOrUndefined(workspace.workspaceFile?.fsPath, basename)
  if (workspaceFileName) {
    return workspaceFileName
  }

  const workspaceFolders = workspace.workspaceFolders ?? []
  if (workspaceFolders.length === 1) {
    const folderName = workspaceFolders[0]?.name?.trim()
    return folderName || basenameOrUndefined(workspaceFolders[0]?.uri?.fsPath, basename) || t('notifications.windowsAgentStop.currentWindow')
  }

  const activeEditorFileName = basenameOrUndefined(window.activeTextEditor?.document?.uri?.fsPath, basename)
  if (activeEditorFileName) {
    return activeEditorFileName
  }

  return t('notifications.windowsAgentStop.currentWindow')
}
