/**
 * memory_note 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

registerTool('memory_note', {
  name: 'memory_note',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_note'),
  icon: 'codicon-edit',
  descriptionFormatter: (args) => {
    const text = typeof args.text === 'string' ? args.text : ''
    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return preview || (getToolMetaDescription('memory_note') ?? 'Record memory')
  },
  contentComponent: MemoryResult,
})
