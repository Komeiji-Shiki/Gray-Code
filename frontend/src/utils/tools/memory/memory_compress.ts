/**
 * memory_compress 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_compress', {
  name: 'memory_compress',
  label: 'Memory Compress',
  icon: 'codicon-collapse-all',
  descriptionFormatter: (args) => {
    const id = typeof args.blockId === 'string' ? args.blockId : '?'
    return `Compress block ${id}`
  },
  contentComponent: MemoryResult,
})
