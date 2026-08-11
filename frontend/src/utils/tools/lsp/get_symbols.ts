/**
 * get_symbols 工具注册
 */

import { registerTool } from '../../toolRegistry'
import GetSymbolsComponent from '../../../components/tools/lsp/get_symbols.vue'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'

// 注册 get_symbols 工具
registerTool('get_symbols', {
  name: 'get_symbols',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('get_symbols'),
  icon: 'codicon-symbol-class',
  
  // 描述生成器 - 显示文件路径（每行一个）
  descriptionFormatter: (args) => {
    if (args.paths && Array.isArray(args.paths)) {
      return (args.paths as string[]).join('\n')
    }
    if (args.path) {
      return args.path as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('get_symbols') ?? getToolDisplayName('get_symbols')
  },
  
  // 使用自定义组件显示内容
  contentComponent: GetSymbolsComponent
})
