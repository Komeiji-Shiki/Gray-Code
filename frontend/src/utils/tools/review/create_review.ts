/**
 * create_review 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'
import { formatReviewToolFallbackContent } from '../../reviewCards'

registerTool('create_review', {
  name: 'create_review',
  label: t('components.message.tool.createReview.label'),
  icon: 'codicon-eye',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const title = (args as any)?.title as string | undefined
    if (path && path.trim()) return path
    if (title && title.trim()) return title.trim()
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('create_review') ?? t('components.message.tool.createReview.fallbackTitle')
  },
  contentFormatter: (args, result) => formatReviewToolFallbackContent('create_review', args, result)
})
