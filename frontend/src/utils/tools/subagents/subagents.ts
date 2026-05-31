/**
 * subagents 工具注册
 */

import { registerTool } from '../../toolRegistry'
import type { ToolUsage } from '../../../types'
import { t } from '../../../i18n'
import { sendToExtension } from '../../../utils/vscode'
import SubAgentsComponent from '../../../components/tools/subagents/subagents.vue'

function normalizeToolIdForRunId(toolId: string): string {
  return toolId.trim().replace(/[^A-Za-z0-9_-]/g, '_')
}

function getSubAgentRunIdFromToolId(toolId: string | undefined): string {
  const normalized = typeof toolId === 'string' ? normalizeToolIdForRunId(toolId) : ''
  return normalized ? `subagent_run_${normalized}` : ''
}

function getSubAgentResultRunId(result: unknown): string {
  const payload = result as any
  const direct = payload?.runId
  const nested = payload?.data?.runId
  return typeof nested === 'string' && nested.trim()
    ? nested.trim()
    : (typeof direct === 'string' && direct.trim() ? direct.trim() : '')
}

function getSubAgentRunId(tool: ToolUsage): string {
  const resultRunId = getSubAgentResultRunId(tool.result)
  if (resultRunId) return resultRunId
  return tool.result ? '' : getSubAgentRunIdFromToolId(tool.id)
}

// 注册 subagents 工具
registerTool('subagents', {
  name: 'subagents',
  label: 'Sub-Agent',
  icon: 'codicon-hubot',
  
  // 动态标签 - 显示代理名称
  labelFormatter: (args) => {
    const agentName = args.agentName as string
    return agentName ? `Sub-Agent: ${agentName}` : 'Sub-Agent'
  },
  
  // 描述生成器 - 显示任务提示
  descriptionFormatter: (args) => {
    const prompt = args.prompt as string || ''
    return prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt
  },
  
  // 使用自定义组件显示内容
  contentComponent: SubAgentsComponent,
  actions: [
    {
      id: 'open-subagent-monitor',
      label: () => t('components.message.tool.openDetails'),
      title: () => t('components.message.tool.openSubAgentMonitorDetails'),
      icon: 'codicon-open-preview',
      variant: 'default',
      visible: (tool) => !!getSubAgentRunId(tool),
      async run(tool, context) {
        const runId = getSubAgentRunId(tool)
        if (!runId) return
        await sendToExtension('subagents.openMonitor', {
          runId,
          conversationId: context.conversationId || undefined
        })
      }
    }
  ]
})
