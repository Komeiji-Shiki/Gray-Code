/**
 * record_progress_milestone 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatProgressToolFallbackContent } from '../../progressCards'

registerTool('record_progress_milestone', {
  name: 'record_progress_milestone',
  label: t('components.message.tool.recordProgressMilestone.label'),
  icon: 'codicon-checklist',
  descriptionFormatter: (args) => {
    const title = (args as any)?.title as string | undefined
    const path = (args as any)?.path as string | undefined
    if (title && title.trim()) return title.trim()
    if (path && path.trim()) return path.trim()
    return t('components.message.tool.recordProgressMilestone.fallbackTitle')
  },
  contentFormatter: (args, result) => formatProgressToolFallbackContent('record_progress_milestone', args, result)
})
