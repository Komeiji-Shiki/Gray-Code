/**
 * memory_recall 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_recall', {
  name: 'memory_recall',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_recall'),
  icon: 'codicon-search',
  descriptionFormatter: (args) => {
    const regex = typeof args.regex === 'string' ? args.regex : '?'
    return `Search: /${regex}/`
  },
  contentComponent: MemoryResult,
})
