import { sendToExtension } from './vscode'

export interface ResolvedWorkspaceItem {
  path: string
  isDirectory: boolean
}

/**
 * Resolve a set of uri/path strings into workspace-relative paths.
 * Kept outside InputBox to avoid coupling the editor to VSCode extension APIs.
 */
export async function resolveWorkspaceItems(inputs: string[]): Promise<ResolvedWorkspaceItem[]> {
  const resolved = await Promise.all(inputs.map(async (raw): Promise<ResolvedWorkspaceItem | null> => {
    const input = (raw || '').trim()
    if (!input) return null

    try {
      const r = await sendToExtension<{ relativePath: string; isDirectory?: boolean }>('getRelativePath', {
        absolutePath: input
      })
      if (r?.relativePath) {
        return { path: r.relativePath, isDirectory: !!r.isDirectory }
      }
    } catch {
      // fallback below
    }

    // Fallback: best-effort file name
    try {
      if (input.startsWith('file://') || input.startsWith('vscode-remote://')) {
        const url = new URL(input)
        const pathName = decodeURIComponent(url.pathname)
        const fileName = pathName.split('/').pop()
        if (fileName) return { path: fileName, isDirectory: false }
      }
    } catch {
      // ignore
    }

    const fileName = input.split(/[/\\]/).pop()
    return fileName ? { path: fileName, isDirectory: false } : null
  }))

  return resolved.filter((item): item is ResolvedWorkspaceItem => item !== null)
}
