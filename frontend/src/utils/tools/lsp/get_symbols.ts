/**
 * get_symbols 工具注册
 */

import { registerTool } from '../../toolRegistry'
import GetSymbolsComponent from '../../../components/tools/lsp/get_symbols.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

// 注册 get_symbols 工具
registerTool('get_symbols', {
  name: 'get_symbols',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '获取符号',
  icon: 'codicon-symbol-class',
  
  // 描述生成器 - 显示文件路径（每行一个）
  descriptionFormatter: (args) => {
    if (args.paths && Array.isArray(args.paths)) {
      return (args.paths as string[]).join('\n')
    }
    if (args.path) {
      return args.path as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return getToolMetaDescription('get_symbols') ?? '获取文件符号'
  },
  
  // 使用自定义组件显示内容
  contentComponent: GetSymbolsComponent
})
