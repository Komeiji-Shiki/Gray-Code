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
    const formatRequest = (request: Record<string, unknown>): string => {
      const path = typeof request.path === 'string' ? request.path : '?'
      const startLine = typeof request.startLine === 'number' ? request.startLine : undefined
      const endLine = typeof request.endLine === 'number' ? request.endLine : undefined
      if (startLine !== undefined && endLine !== undefined) return `${path} [L${startLine}-${endLine}]`
      if (startLine !== undefined) return `${path} [L${startLine}+]`
      if (endLine !== undefined) return `${path} [L1-${endLine}]`
      return path
    }

    if (Array.isArray(args.files)) {
      const requests = args.files.filter((item): item is Record<string, unknown> => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
      ))
      if (requests.length === 0) return '?'
      const first = formatRequest(requests[0])
      return requests.length === 1 ? first : `${first} +${requests.length - 1}`
    }

    return formatRequest(args)
  },
  
  // 使用自定义组件显示内容
  contentComponent: ReadFileComponent
})
