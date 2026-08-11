/**
 * record_review_milestone 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'
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
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('record_review_milestone') ?? t('components.message.tool.recordReviewMilestone.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('record_review_milestone', args, result)
})
