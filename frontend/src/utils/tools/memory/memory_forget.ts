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
    const raw = typeof args.blockId === 'string' ? args.blockId : '?'
    if (/^\d+$/.test(raw)) {
      return `Delete memory #${raw}`
    }
    if (/^\d+,\d+$/.test(raw)) {
      const [lo, hi] = raw.split(',')
      return `Delete memories #${lo}-#${hi}`
    }
    return `Forget block ${raw}`
  },
  contentComponent: MemoryResult,
})
