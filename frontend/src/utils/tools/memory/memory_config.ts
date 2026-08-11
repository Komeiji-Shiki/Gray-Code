/**
 * memory_config 工具注册
 */
import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import MemoryResult from '../../../components/tools/memory/MemoryResult.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

registerTool('memory_config', {
  name: 'memory_config',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('memory_config'),
  icon: 'codicon-settings-gear',
  descriptionFormatter: (args) => {
    const keys = Object.keys(args).filter(k => k !== 'toolName')
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return keys.length > 0 ? `Config: ${keys.join(', ')}` : getToolMetaDescription('memory_config') ?? 'View config'
  },
  contentComponent: MemoryResult,
})
