/**
 * 打开工作区文件的 composable
 *
 * 封装工具卡片中"点击文件名跳转到编辑器"的能力：
 * - openFile: 仅打开文件
 * - openFileAt: 打开文件并定位到指定行（1-based），后端会临时高亮目标范围
 *
 * 失败时静默处理（文件可能尚未创建、已被删除或位于工作区之外），
 * 与现有调用方（MessageTaskCards / MarkdownRenderer 等）的行为保持一致。
 */

import { sendToExtension } from '../utils/vscode'

export function useOpenWorkspaceFile() {
  /** 打开文件（不定位行号） */
  async function openFile(path: string | undefined | null): Promise<void> {
    const target = (path || '').trim()
    if (!target) return
    try {
      await sendToExtension('openWorkspaceFile', { path: target })
    } catch {
      // 静默失败：文件不存在 / 不在工作区内
    }
  }

  /** 打开文件并定位到行（1-based）。未提供有效行号时退化为仅打开文件 */
  async function openFileAt(
    path: string | undefined | null,
    startLine?: number,
    endLine?: number
  ): Promise<void> {
    const target = (path || '').trim()
    if (!target) return

    const start = typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? Math.floor(startLine)
      : undefined

    if (!start) {
      await openFile(target)
      return
    }

    const end = typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= start
      ? Math.floor(endLine)
      : undefined

    try {
      await sendToExtension('openWorkspaceFileAt', {
        path: target,
        startLine: start,
        ...(end !== undefined ? { endLine: end } : {})
      })
    } catch {
      // 静默失败
    }
  }

  return { openFile, openFileAt }
}
