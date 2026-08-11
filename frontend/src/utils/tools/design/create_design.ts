/**
 * create_design 工具注册（前端展示）
 */

import { registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'

registerTool('create_design', {
  name: 'create_design',
  label: t('components.message.tool.createDesign.label'),
  icon: 'codicon-lightbulb',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const title = (args as any)?.title as string | undefined
    if (path && path.trim()) return path
    if (title && title.trim()) return title.trim()
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('create_design') ?? t('components.message.tool.createDesign.fallbackTitle')
  },
  contentFormatter: (args, result) => {
    const content = ((result as any)?.data?.content || (args as any)?.design || '') as string
    return content || ''
  }
})
