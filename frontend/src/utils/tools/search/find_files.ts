/**
 * find_files 工具注册
 */

import { registerTool } from '../../toolRegistry'
import FindFilesComponent from '../../../components/tools/search/find_files.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

// 注册 find_files 工具
registerTool('find_files', {
  name: 'find_files',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '查找文件',
  icon: 'codicon-search',
  
  // 描述生成器 - 显示查找模式（每行一个）
  descriptionFormatter: (args) => {
    if (args.patterns && Array.isArray(args.patterns)) {
      return (args.patterns as string[]).join('\n')
    }
    if (args.pattern) {
      return args.pattern as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return getToolMetaDescription('find_files') ?? '查找文件'
  },
  
  // 使用自定义组件显示内容
  contentComponent: FindFilesComponent
})