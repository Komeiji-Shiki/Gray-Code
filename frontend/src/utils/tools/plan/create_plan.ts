/**
 * create_plan 工具注册（前端展示）
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { t } from '../../../i18n'
import { getToolMetaDescription } from '../toolMetaLookup'

const TodoWritePanel = lazyToolComponent(() => import('../../../components/tools/todo/todo_write.vue'))

registerTool('create_plan', {
  name: 'create_plan',
  label: t('components.message.tool.createPlan.label'),
  icon: 'codicon-list-unordered',
  descriptionFormatter: (args) => {
    const path = (args as any)?.path as string | undefined
    const title = (args as any)?.title as string | undefined
    if (path && path.trim()) return path
    if (title && title.trim()) return title.trim()
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化标题
    return getToolMetaDescription('create_plan') ?? t('components.message.tool.createPlan.fallbackTitle')
  },
  contentFormatter: (args, result) => {
    const content = ((result as any)?.data?.content || (args as any)?.plan || '') as string
    return content || ''
  },
  contentComponent: TodoWritePanel
})

