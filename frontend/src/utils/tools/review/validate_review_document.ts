/**
 * validate_review_document 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatReviewToolFallbackContent } from '../../reviewCards'

registerTool('validate_review_document', {
  name: 'validate_review_document',
  label: t('components.message.tool.validateReviewDocument.label'),
  icon: 'codicon-verified',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    if (path && path.trim()) return path.trim()
    return t('components.message.tool.validateReviewDocument.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('validate_review_document', args, result)
})
