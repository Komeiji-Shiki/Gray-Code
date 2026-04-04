/**
 * create_progress 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { formatProgressToolFallbackContent } from '../../progressCards'

registerTool('create_progress', {
  name: 'create_progress',
  label: t('components.message.tool.createProgress.label'),
  icon: 'codicon-book',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const projectName = (args as any)?.projectName as string | undefined
    if (path && path.trim()) return path.trim()
    if (projectName && projectName.trim()) return projectName.trim()
    return t('components.message.tool.createProgress.fallbackTitle')
  },
  contentFormatter: (args, result) => formatProgressToolFallbackContent('create_progress', args, result)
})
