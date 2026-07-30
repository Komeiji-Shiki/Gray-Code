/**
 * memory_note 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_note', {
  name: 'memory_note',
  label: 'Memory Note',
  icon: 'codicon-edit',
  descriptionFormatter: (args) => {
    const text = typeof args.text === 'string' ? args.text : ''
    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text
    return preview || 'Record memory'
  },
  contentComponent: MemoryResult,
})
