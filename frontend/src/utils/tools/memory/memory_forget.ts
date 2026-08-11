/**
 * memory_forget 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_forget', {
  name: 'memory_forget',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_forget'),
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
