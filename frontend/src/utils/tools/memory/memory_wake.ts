/**
 * memory_wake 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_wake', {
  name: 'memory_wake',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_wake'),
  icon: 'codicon-bell',
  descriptionFormatter: (args) => {
    const part = typeof args.part === 'number' ? ` part ${args.part}` : ''
    return `Wake memory${part}`
  },
  contentComponent: MemoryResult,
})
