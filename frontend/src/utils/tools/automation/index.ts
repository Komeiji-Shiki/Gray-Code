import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import { toolIcon } from '../../toolPresentation'
import { actionLabel, text } from '../../../components/tools/automation/automationResult'

const BrowserToolPanel = lazyToolComponent(() => import('../../../components/tools/automation/BrowserToolPanel.vue'))
const ComputerToolPanel = lazyToolComponent(() => import('../../../components/tools/automation/ComputerToolPanel.vue'))
const PetControlPanel = lazyToolComponent(() => import('../../../components/tools/automation/PetControlPanel.vue'))
const BotAttachmentPanel = lazyToolComponent(() => import('../../../components/tools/automation/BotAttachmentPanel.vue'))

const groups = [
  { names: ['browser_tabs', 'browser_read', 'browser_action', 'browser_files'], component: BrowserToolPanel },
  { names: ['computer_windows', 'computer_observe', 'computer_control', 'computer_action'], component: ComputerToolPanel },
  { names: ['pet_control'], component: PetControlPanel },
  { names: ['bot_read_attachment'], component: BotAttachmentPanel },
]
for (const group of groups) for (const name of group.names) registerTool(name, {
  name,
  icon: toolIcon(name),
  labelFormatter: () => getToolDisplayName(name),
  descriptionFormatter: args => {
    const target = text(args.url || args.path || args.windowId || args.tabId || args.id).replace(/\s+/g, ' ').slice(0, 140)
    return [actionLabel(args.action), target].filter(Boolean).join(' · ') || getToolDisplayName(name)
  },
  contentComponent: group.component,
})
