/**
 * memory_zoom 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_zoom', {
  name: 'memory_zoom',
  label: 'Memory Zoom',
  icon: 'codicon-zoom-in',
  descriptionFormatter: (args) => {
    const id = typeof args.blockId === 'string' ? args.blockId : '?'
    return `Zoom block ${id}`
  },
  contentComponent: MemoryResult,
})
