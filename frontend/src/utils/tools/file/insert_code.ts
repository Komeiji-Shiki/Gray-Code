/**
 * insert_code 工具注册
 */

import { registerTool } from '../../toolRegistry'
import { createDiffPreviewAction } from '../diffPreviewAction'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'
import InsertCodeComponent from '../../../components/tools/file/insert_code.vue'

// 单个插入条目类型
interface InsertEntry {
  path: string
  line: number
  content: string
}

// 注册 insert_code 工具
registerTool('insert_code', {
  name: 'insert_code',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('insert_code'),
  icon: 'codicon-diff-added',
  
  // 描述生成器 - 显示文件路径列表（每行一个）
  descriptionFormatter: (args) => {
    const files = args.files as InsertEntry[] | undefined
    if (!files || !Array.isArray(files) || files.length === 0) return t('utils.tools.noFile')
    return files.map(f => `${f.path} ${t('utils.tools.lineBefore', { line: f.line ?? '?' })}`).join('\n')
  },
  
  // 使用自定义组件显示内容
  contentComponent: InsertCodeComponent,
  actions: [
    // 修改原因：insert_code 的 diff 预览按钮不应继续由 ToolMessage 专用逻辑渲染。
    // 修改方式：将文件列表解析封装为共享 diff preview action。
    // 修改目的：所有显眼操作按钮统一由 ToolConfig.actions 驱动。
    createDiffPreviewAction((args) => {
      const files = args.files as InsertEntry[] | undefined
      if (!files || !Array.isArray(files) || files.length === 0) return []
      return files.map(f => f.path)
    })
  ]
})
