/**
 * read_file 工具注册
 */

import { registerTool } from '../../toolRegistry'
import ReadFileComponent from '../../../components/tools/file/read_file.vue'

// 注册 read_file 工具
registerTool('read_file', {
  name: 'read_file',
  label: '读取文件',
  icon: 'codicon-file-text',
  
  // 描述生成器 - 显示文件路径和行范围
  descriptionFormatter: (args) => {
    const path = typeof args.path === 'string' ? args.path : null
    if (!path) {
      return '?'
    }

    let desc = path
    const startLine = typeof args.startLine === 'number' ? args.startLine : undefined
    const endLine = typeof args.endLine === 'number' ? args.endLine : undefined
    if (startLine !== undefined && endLine !== undefined) {
      desc += ` [L${startLine}-${endLine}]`
    } else if (startLine !== undefined) {
      desc += ` [L${startLine}+]`
    } else if (endLine !== undefined) {
      desc += ` [L1-${endLine}]`
    }
    return desc
  },
  
  // 使用自定义组件显示内容
  contentComponent: ReadFileComponent
})
