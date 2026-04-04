/**
 * update_progress 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatProgressToolFallbackContent } from '../../progressCards'

registerTool('update_progress', {
  name: 'update_progress',
  label: t('components.message.tool.updateProgress.label'),
  icon: 'codicon-sync',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const currentFocus = (args as any)?.currentFocus as string | undefined
    if (path && path.trim()) return path.trim()
    if (currentFocus && currentFocus.trim()) return currentFocus.trim()
    return t('components.message.tool.updateProgress.fallbackTitle')
  },
  contentFormatter: (args, result) => formatProgressToolFallbackContent('update_progress', args, result)
})
