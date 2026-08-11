/**
 * create_directory 工具注册
 */

import { registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'

// 注册 create_directory 工具
// 只在外部显示创建的目录路径，不需要展开面板
registerTool('create_directory', {
  name: 'create_directory',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('create_directory'),
  icon: 'codicon-new-folder',
  
  // 不可展开 - 只显示创建的目录路径列表
  expandable: false,
  
  // 描述生成器 - 显示创建的目录路径（一行一个）
  descriptionFormatter: (args) => {
    if (args.paths && Array.isArray(args.paths)) {
      return (args.paths as string[]).join('\n')
    }
    if (args.path) {
      return args.path as string
    }
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('create_directory') ?? getToolDisplayName('create_directory')
  }
})