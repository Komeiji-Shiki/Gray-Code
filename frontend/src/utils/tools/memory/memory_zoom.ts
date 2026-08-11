/**
 * memory_zoom 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'

registerTool('memory_zoom', {
  name: 'memory_zoom',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_zoom'),
  icon: 'codicon-zoom-in',
  descriptionFormatter: (args) => {
    const id = typeof args.blockId === 'string' ? args.blockId : '?'
    return `Zoom block ${id}`
  },
  contentComponent: MemoryResult,
})
