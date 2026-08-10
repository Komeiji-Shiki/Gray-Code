/**
 * read_file 工具注册
 */

import { registerTool } from '../../toolRegistry'
import ReadFileComponent from '../../../components/tools/file/read_file.vue'

export function formatReadFileDescription(args: Record<string, unknown>): string {
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
      typeof item === 'object'
      && item !== null
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).path === 'string'
    ))
    if (requests.length > 0) return requests.map(formatRequest).join('\n')
  }

  // 单文件调用可能由工具参数规范化补出 files: []；空批量不能遮蔽真实的 path。
  return formatRequest(args)
}

// 注册 read_file 工具
registerTool('read_file', {
  name: 'read_file',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '读取文件',
  icon: 'codicon-file-text',
  
  // 描述生成器：批量读取逐行显示每个真实文件名，不再折叠成“首文件 +N”。
  descriptionFormatter: formatReadFileDescription,
  
  // 使用自定义组件显示内容
  contentComponent: ReadFileComponent
})
