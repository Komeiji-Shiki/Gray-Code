import { lazyToolComponent, registerTool, toolRegistry } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import { getToolMetaDescription } from '../toolMetaLookup'

const MemoryResult = lazyToolComponent(() => import('../../../components/tools/memory/MemoryResult.vue'))

registerTool('engineering_log', {
  name: 'engineering_log',
  labelFormatter: args => `${getToolDisplayName('engineering_log')} · ${getToolDisplayName(`memory_${args.action}`)}`,
  icon: 'codicon-book',
  descriptionFormatter: args => {
    const { action, ...parameters } = args
    return toolRegistry.get(`memory_${action}`)?.descriptionFormatter(parameters)
      ?? getToolMetaDescription('engineering_log')
      ?? getToolDisplayName('engineering_log')
  },
  contentComponent: MemoryResult,
})
