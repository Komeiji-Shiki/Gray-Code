/**
 * validate_review_document 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'
import { formatReviewToolFallbackContent } from '../../reviewCards'

registerTool('validate_review_document', {
  name: 'validate_review_document',
  label: t('components.message.tool.validateReviewDocument.label'),
  icon: 'codicon-verified',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    if (path && path.trim()) return path.trim()
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('validate_review_document') ?? t('components.message.tool.validateReviewDocument.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('validate_review_document', args, result)
})
