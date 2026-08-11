/**
 * finalize_review 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'
import { formatReviewToolFallbackContent } from '../../reviewCards'

registerTool('finalize_review', {
  name: 'finalize_review',
  label: t('components.message.tool.finalizeReview.label'),
  icon: 'codicon-check-all',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const conclusion = (args as any)?.conclusion as string | undefined
    if (path && path.trim()) return path.trim()
    if (conclusion && conclusion.trim()) return conclusion.trim()
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('finalize_review') ?? t('components.message.tool.finalizeReview.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('finalize_review', args, result)
})
