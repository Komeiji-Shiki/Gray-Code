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
    if (/^\d+$/.test(id)) return `Delete memory #${id}`
    if (/^\d+,\d+$/.test(id)) {
      const [lo, hi] = id.split(',')
      return `Delete memories #${lo}-#${hi}`
    }
    return `Forget block ${id}`
  },
  contentComponent: MemoryResult,
})
