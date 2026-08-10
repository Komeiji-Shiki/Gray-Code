/**
 * create_directory 工具注册
 */

import { registerTool } from '../../toolRegistry'

// 注册 create_directory 工具
// 只在外部显示创建的目录路径，不需要展开面板
registerTool('create_directory', {
  name: 'create_directory',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '创建目录',
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
    return '创建目录'
  }
})