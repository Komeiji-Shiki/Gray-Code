/**
 * execute_command 工具注册
 */

import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'
import ExecuteCommandComponent from '../../../components/tools/terminal/execute_command.vue'

// 注册 execute_command 工具
registerTool('execute_command', {
  name: 'execute_command',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('execute_command'),
  icon: 'codicon-terminal',
  
  // 描述生成器 - 显示命令
  descriptionFormatter: (args) => {
    const command = args.command as string || ''
    const cwd = args.cwd as string
    const shell = args.shell as string
    
    let desc = command
    if (cwd) {
      desc += `\n${t('utils.tools.cwdLabel', { cwd })}`
    }
    if (shell && shell !== 'default') {
      // Shell 名称为通用术语，保持原文不翻译
      desc += `\nShell: ${shell}`
    }
    return desc
  },
  
  // 使用自定义组件显示内容
  contentComponent: ExecuteCommandComponent
})