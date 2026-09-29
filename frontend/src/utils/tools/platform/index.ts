import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import { toolIcon, toolSummary } from '../../toolPresentation'

const WorkspaceToolResult = lazyToolComponent(() => import('../../../components/tools/platform/WorkspaceToolResult.vue'))
const ProcessToolResult = lazyToolComponent(() => import('../../../components/tools/platform/ProcessToolResult.vue'))
const TerminalTaskResult = lazyToolComponent(() => import('../../../components/tools/platform/TerminalTaskResult.vue'))
const TeamToolResult = lazyToolComponent(() => import('../../../components/tools/platform/TeamToolResult.vue'))
const LongMemoryToolResult = lazyToolComponent(() => import('../../../components/tools/platform/LongMemoryToolResult.vue'))

// 只注册独立平台的新协议；旧 memory_wake/note/recall 等工程日志面板保持不变。
for (const [names, component] of [
  [['workspace_files', 'search_files'], WorkspaceToolResult],
  [['run_command', 'process_session'], ProcessToolResult],
  [['terminal_task'], TerminalTaskResult],
  [['team_tasks', 'team_wait'], TeamToolResult],
  [['memory_topics', 'memory_search', 'memory_read', 'memory_remember', 'memory_revise', 'memory_remove', 'memory_summarize'], LongMemoryToolResult],
] as const) {
  for (const name of names) registerTool(name, {
    name,
    icon: toolIcon(name),
    labelFormatter: () => getToolDisplayName(name),
    descriptionFormatter: args => toolSummary(name, args),
    contentComponent: component,
  })
}
