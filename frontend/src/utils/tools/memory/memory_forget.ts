/**
 * memory_forget 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_forget', {
  name: 'memory_forget',
  label: 'Memory Forget',
  icon: 'codicon-trash',
  descriptionFormatter: (args) => {
    const id = typeof args.blockId === 'string' ? args.blockId : '?'
    return `Forget block ${id}`
  },
  contentComponent: MemoryResult,
})
