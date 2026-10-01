import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDescription } from '../../toolLocalization'
import { t } from '../../../i18n'

registerTool('agent_send_message', {
  name: 'agent_send_message', icon: 'codicon-send',
  descriptionFormatter: args => typeof args.message === 'string' ? args.message.replace(/\s+/g, ' ').slice(0, 100) : '',
  contentComponent: lazyToolComponent(() => import('../../../components/tools/subagents/AgentMessagePanel.vue')),
})
registerTool('context_status', {
  name: 'context_status', icon: 'codicon-dashboard',
  descriptionFormatter: () => getToolDescription('context_status', ''),
  contentComponent: lazyToolComponent(() => import('../../../components/tools/context/ContextStatusPanel.vue')),
})
const ContextToolPanel = lazyToolComponent(() => import('../../../components/tools/context/ContextToolPanel.vue'))
const text = (value: unknown) => typeof value === 'string' && value.length ? value : undefined

/** 历史工具按动作显示摘要：list/windows 没有查询参数，也要说明这次做了什么。 */
export function formatContextHistoryDescription(args: Record<string, unknown>): string {
  const action = text(args.action)
  const key = action && ['windows', 'list', 'search', 'read'].includes(action) ? action : undefined
  const label = key ? t(`components.tools.contextNotes.historyActions.${key}`) : ''
  const detail = key === 'search' ? text(args.query)
    : key === 'read' ? [text(args.messageId), typeof args.offset === 'number' ? `offset=${args.offset}` : undefined].filter(Boolean).join(' · ')
      : key === 'list' ? text(args.windowId) ?? text(args.beforeId) : undefined
  return [label, detail].filter(Boolean).join(' · ')
}

registerTool('context_notes', {
  name: 'context_notes', icon: 'codicon-note',
  descriptionFormatter: args => {
    if (args.action === 'record' && Array.isArray(args.entries))
      return t('components.tools.contextNotes.submitted', { count: args.entries.length })
    return [args.name, args.query, args.noteId, args.taskId, args.messageId].find(value => typeof value === 'string' && value.length) as string
      || (Array.isArray(args.ids) ? args.ids.filter(value => typeof value === 'string').join(' · ') : '')
  },
  contentComponent: ContextToolPanel,
})
registerTool('context_history', {
  name: 'context_history', icon: 'codicon-history',
  descriptionFormatter: formatContextHistoryDescription,
  contentComponent: ContextToolPanel,
})
