/**
 * delete_file 工具注册
 */

import { registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'

// 注册 delete_file 工具
// 只在外部显示删除的文件路径，不需要展开面板
registerTool('delete_file', {
  name: 'delete_file',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '删除',
  icon: 'codicon-trash',
  
  // 不可展开 - 只显示删除的路径列表
  expandable: false,
  
  // 描述生成器 - 显示删除的文件/目录路径（一行一个）
  descriptionFormatter: (args) => {
    if (args.paths && Array.isArray(args.paths)) {
      return (args.paths as string[]).join('\n')
    }
    if (args.path) {
      return args.path as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return getToolMetaDescription('delete_file') ?? '删除'
  }
})