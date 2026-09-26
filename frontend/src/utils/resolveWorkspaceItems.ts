import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension, showNotification } from './vscode'
import { t } from '../i18n'

export interface ResolvedWorkspaceItem {
  path: string
  isDirectory: boolean
}

/**
 * Resolve a set of uri/path strings into workspace-relative paths.
 * Kept outside InputBox to avoid coupling the editor to VSCode extension APIs.
 */
export async function resolveWorkspaceItems(inputs: string[], conversationId?: string | null): Promise<ResolvedWorkspaceItem[]> {
  const resolved = await Promise.all(inputs.map(async (raw): Promise<ResolvedWorkspaceItem | null> => {
    const input = (raw || '').trim()
    if (!input) return null

    try {
      const r = await sendToExtension<{ relativePath: string; isDirectory?: boolean }>(MESSAGE_NAMES.getRelativePath, {
        absolutePath: input,
        ...(conversationId ? { conversationId } : {})
      })
      if (r?.relativePath) {
        return { path: r.relativePath, isDirectory: !!r.isDirectory }
      }
    } catch (error) {
      // 路径被宿主拒绝时不能猜同名文件，否则可能插入工作区里另一份文件。
      await showNotification(error instanceof Error ? error.message : t('components.input.promptContext.readFailed'), 'error')
    }
    return null
  }))

  return resolved.filter((item): item is ResolvedWorkspaceItem => item !== null)
}
