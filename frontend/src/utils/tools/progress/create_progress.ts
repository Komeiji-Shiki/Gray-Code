/**
 * create_progress 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'
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
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('create_progress') ?? t('components.message.tool.createProgress.fallbackTitle')
  },
  contentFormatter: (args, result) => formatProgressToolFallbackContent('create_progress', args, result)
})
