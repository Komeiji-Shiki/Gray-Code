/**
 * 打开工作区文件的 composable
 *
 * 封装工具卡片中"点击文件名跳转到编辑器"的能力：
 * - openFile: 仅打开文件
 * - openFileAt: 打开文件并定位到指定行（1-based），后端会临时高亮目标范围
 *
 * 失败时统一显示非阻塞通知，避免用户点击文件入口后毫无反馈。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension, showNotification } from '../utils/vscode'
import { t } from '../i18n'

export function useOpenWorkspaceFile() {
  /** 打开文件（不定位行号） */
  async function openFile(path: string | undefined | null): Promise<void> {
    const target = (path || '').trim()
    if (!target) return
    try {
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFile, { path: target })
    } catch (error) {
      console.error('[useOpenWorkspaceFile] Failed to open file:', error)
      await showNotification(`${t('components.common.markdown.openFileFailed')}: ${target}`, 'error')
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
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFileAt, {
        path: target,
        startLine: start,
        ...(end !== undefined ? { endLine: end } : {})
      })
    } catch (error) {
      console.error('[useOpenWorkspaceFile] Failed to open file at location:', error)
      await showNotification(`${t('components.common.markdown.openFileFailed')}: ${target}`, 'error')
    }
  }

  return { openFile, openFileAt }
}
