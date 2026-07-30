/**
 * memory_recall 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_recall', {
  name: 'memory_recall',
  label: 'Memory Recall',
  icon: 'codicon-search',
  descriptionFormatter: (args) => {
    const regex = typeof args.regex === 'string' ? args.regex : '?'
    return `Search: /${regex}/`
  },
  contentComponent: MemoryResult,
})
