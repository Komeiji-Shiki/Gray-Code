/**
 * memory_compress 工具注册
 */
import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'

const MemoryResult = lazyToolComponent(() => import('../../../components/tools/memory/MemoryResult.vue'))

registerTool('memory_compress', {
  name: 'memory_compress',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_compress'),
  icon: 'codicon-collapse-all',
  descriptionFormatter: (args) => {
    const id = typeof args.blockId === 'string' ? args.blockId : '?'
    return `Compress block ${id}`
  },
  contentComponent: MemoryResult,
})
