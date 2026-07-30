/**
 * memory_config 工具注册
 */
import { registerTool } from '../../toolRegistry'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_config', {
  name: 'memory_config',
  label: 'Memory Config',
  icon: 'codicon-settings-gear',
  descriptionFormatter: (args) => {
    const keys = Object.keys(args).filter(k => k !== 'toolName')
    return keys.length > 0 ? `Config: ${keys.join(', ')}` : 'View config'
  },
  contentComponent: MemoryResult,
})
