import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDescription } from '../../toolLocalization'

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
for (const name of ['context_notes', 'context_history']) {
  registerTool(name, {
    name, icon: name === 'context_notes' ? 'codicon-note' : 'codicon-history',
    descriptionFormatter: args => [args.name, args.query, args.messageId].find(value => typeof value === 'string' && value.length) as string || '',
    contentComponent: ContextToolPanel,
  })
}
