/**
 * find_files 工具注册
 */

import { registerTool } from '../../toolRegistry'
import FindFilesComponent from '../../../components/tools/search/find_files.vue'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'

// 注册 find_files 工具
registerTool('find_files', {
  name: 'find_files',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('find_files'),
  icon: 'codicon-search',
  
  // 描述生成器 - 显示查找模式（每行一个）
  descriptionFormatter: (args) => {
    if (args.patterns && Array.isArray(args.patterns)) {
      return (args.patterns as string[]).join('\n')
    }
    if (args.pattern) {
      return args.pattern as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('find_files') ?? getToolDisplayName('find_files')
  },
  
  // 使用自定义组件显示内容
  contentComponent: FindFilesComponent
})