/**
 * goto_definition 工具注册
 */

import { registerTool } from '../../toolRegistry'
import GotoDefinitionComponent from '../../../components/tools/lsp/goto_definition.vue'

// 注册 goto_definition 工具
registerTool('goto_definition', {
  name: 'goto_definition',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '跳转到定义',
  icon: 'codicon-go-to-file',
  
  // 描述生成器
  descriptionFormatter: (args) => {
    const path = args.path as string || ''
    const line = args.line as number || 0
    const symbol = args.symbol as string || ''
    
    if (symbol) {
      return `${path}:${line} (${symbol})`
    }
    return `${path}:${line}`
  },
  
  // 使用自定义组件显示内容
  contentComponent: GotoDefinitionComponent
})
