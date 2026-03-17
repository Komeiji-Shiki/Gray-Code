/**
 * record_review_milestone 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatReviewToolFallbackContent } from '../../reviewCards'

registerTool('record_review_milestone', {
  name: 'record_review_milestone',
  label: t('components.message.tool.recordReviewMilestone.label'),
  icon: 'codicon-list-unordered',
  descriptionFormatter: (args) => {
    const milestoneTitle = (args as any)?.milestoneTitle as string | undefined
    const path = (args as any)?.path as string | undefined
    if (milestoneTitle && milestoneTitle.trim()) return milestoneTitle.trim()
    if (path && path.trim()) return path.trim()
    return t('components.message.tool.recordReviewMilestone.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('record_review_milestone', args, result)
})
