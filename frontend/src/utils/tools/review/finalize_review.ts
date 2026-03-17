/**
 * finalize_review 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
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
    return t('components.message.tool.finalizeReview.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('finalize_review', args, result)
})
