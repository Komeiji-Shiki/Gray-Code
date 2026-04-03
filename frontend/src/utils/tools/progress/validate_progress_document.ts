/**
 * validate_progress_document 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatProgressToolFallbackContent } from '../../progressCards'

registerTool('validate_progress_document', {
  name: 'validate_progress_document',
  label: t('components.message.tool.validateProgressDocument.label'),
  icon: 'codicon-verified',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    if (path && path.trim()) return path.trim()
    return t('components.message.tool.validateProgressDocument.fallbackTitle')
  },
  contentFormatter: (args, result) => formatProgressToolFallbackContent('validate_progress_document', args, result)
})
