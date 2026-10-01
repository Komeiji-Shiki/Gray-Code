/**
 * read_file 工具注册
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'
import type { ToolUsage } from '../../../types'

const ReadFileComponent = lazyToolComponent(() => import('../../../components/tools/file/read_file.vue'))

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** 后端把 file_path 规范化为 path（paramAliases），卡片保存的是模型原始参数，需要同样识别。 */
function requestPath(request: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path']) {
    const value = request[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** 参数里没有可识别的路径时，用结果中实际读取的文件路径（成功和失败的条目都带 path）。 */
function resultPaths(tool?: ToolUsage): string[] {
  const result = asRecord(tool?.result)
  const results = asRecord(result?.data)?.results ?? result?.results
  if (!Array.isArray(results)) return []
  return results.flatMap(item => {
    const path = asRecord(item)?.path
    return typeof path === 'string' && path.trim() ? [path] : []
  })
}

export function formatReadFileDescription(args: Record<string, unknown>, tool?: ToolUsage): string {
  const formatRequest = (request: Record<string, unknown>, path: string): string => {
    const startLine = typeof request.startLine === 'number' ? request.startLine : undefined
    const endLine = typeof request.endLine === 'number' ? request.endLine : undefined
    if (startLine !== undefined && endLine !== undefined) return `${path} [L${startLine}-${endLine}]`
    if (startLine !== undefined) return `${path} [L${startLine}+]`
    if (endLine !== undefined) return `${path} [L1-${endLine}]`
    return path
  }

  if (Array.isArray(args.files)) {
    const requests = args.files.flatMap(item => {
      const request = asRecord(item)
      const path = request && requestPath(request)
      return request && path ? [formatRequest(request, path)] : []
    })
    if (requests.length > 0) return requests.join('\n')
  }

  // 单文件调用可能由工具参数规范化补出 files: []；空批量不能遮蔽真实的 path。
  const path = requestPath(args)
  if (path) return formatRequest(args, path)
  const fromResult = resultPaths(tool)
  return fromResult.length > 0 ? fromResult.join('\n') : t('utils.tools.noFile')
}

// 注册 read_file 工具
registerTool('read_file', {
  name: 'read_file',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('read_file'),
  icon: 'codicon-file-text',
  
  // 描述生成器：批量读取逐行显示每个真实文件名，不再折叠成“首文件 +N”。
  descriptionFormatter: formatReadFileDescription,
  
  // 使用自定义组件显示内容
  contentComponent: ReadFileComponent
})
