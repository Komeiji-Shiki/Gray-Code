import type { AgentDefinition } from '@graycode/contracts';
import type { SettingsManager } from '../../../../backend/modules/settings/SettingsManager';
import { DEFAULT_TOOL_AUTO_EXEC_CONFIG } from '../../../../backend/modules/settings/types/toolsTypes';
import type { PlatformApplication } from '../application';

/** “自动执行”勾选换算成审批规则，运行时与设置页共用；没有规则的工具按每次操作的效果决定是否确认。 */
export function toolApprovalRules(preferences: SettingsManager, names: string[], mcpNames: string[]): Record<string, 'auto' | 'ask'> {
  const autoExec = { ...preferences.getToolAutoExecConfig() };
  // 旧配置可能没有新增操控工具的键；执行时与设置页采用同一套勾选规则。
  for (const name of [...names.filter(name => name.startsWith('computer_') || name.startsWith('browser_')), ...mcpNames]) {
    autoExec[name] = preferences.isToolAutoExec(name);
  }
  if (!Object.hasOwn(preferences.getScalarSettings('toolAutoExec').toolAutoExec ?? {}, 'execute_command')) delete autoExec.execute_command;
  return Object.fromEntries(Object.entries(autoExec).map(([name, enabled]) => [name, enabled ? 'auto' as const : 'ask' as const]));
}

/** 用户是否单独设置过该工具；默认配置里的值随初始化写入设置，与默认值相同时不算。 */
export function toolApprovalConfigured(preferences: SettingsManager, name: string): boolean {
  const configured = preferences.getScalarSettings('toolAutoExec').toolAutoExec ?? {};
  if (!Object.hasOwn(configured, name)) return false;
  return !Object.hasOwn(DEFAULT_TOOL_AUTO_EXEC_CONFIG, name) || configured[name] !== DEFAULT_TOOL_AUTO_EXEC_CONFIG[name];
}

/** 桌面与 Bot 共用工具启用和审批配置，任务开始时捕获一次。 */
export function configuredAgent(app: PlatformApplication, agent: AgentDefinition): AgentDefinition {
  const preferences = app.product.runtimeSettings();
  const mcpNames = app.mcp.names();
  // 默认 Agent 跟随内置工具目录升级；自定义 Agent 沿用原清单，显式禁用项继续生效。
  const names = agent.id === 'default' ? app.tools.names().filter(name => !name.startsWith('mcp_')) : agent.toolNames;
  return { ...agent, toolNames: [...new Set([...names, ...mcpNames])].filter(name => preferences.isToolEnabled(name)),
    toolApproval: { ...toolApprovalRules(preferences, names, mcpNames), ...agent.toolApproval } };
}
