import type { AgentDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

/** 桌面与 Bot 共用工具启用和审批配置，任务开始时捕获一次。 */
export function configuredAgent(app: PlatformApplication, agent: AgentDefinition): AgentDefinition {
  const preferences = app.product.runtimeSettings();
  const autoExec = { ...preferences.getToolAutoExecConfig() };
  if (!Object.hasOwn(preferences.getSettings().toolAutoExec ?? {}, 'execute_command')) delete autoExec.execute_command;
  // 默认 Agent 跟随内置工具目录升级；自定义 Agent 沿用原清单，显式禁用项继续生效。
  const names = agent.id === 'default' ? app.tools.declarations().map(tool => tool.name).filter(name => !name.startsWith('mcp_')) : agent.toolNames;
  return { ...agent, toolNames: [...new Set([...names, ...app.mcp.names()])].filter(name => preferences.isToolEnabled(name)),
    toolApproval: { ...Object.fromEntries(Object.entries(autoExec).map(([name, enabled]) => [name, enabled ? 'auto' as const : 'ask' as const])), ...agent.toolApproval } };
}
