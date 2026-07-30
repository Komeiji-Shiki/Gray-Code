/**
 * memory_wake 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_wake', {
  name: 'memory_wake',
  label: 'Memory Wake',
  icon: 'codicon-bell',
  descriptionFormatter: (args) => {
    const part = typeof args.part === 'number' ? ` part ${args.part}` : ''
    return `Wake memory${part}`
  },
  contentComponent: MemoryResult,
})
