import type { AgentDefinition } from '@graycode/contracts';
import type { SettingsManager } from '../../../../backend/modules/settings/SettingsManager';
import { DEFAULT_TOOL_AUTO_EXEC_CONFIG } from '../../../../backend/modules/settings/types/toolsTypes';
import type { PlatformApplication } from '../application';
import { CONTEXT_TOOL_NAMES } from '../../../../shared/contextManagement';
import { withEngineeringLogAgent } from '../memory/engineeringLogPolicy';
import { ENGINEERING_LOG_LEGACY_NAMES } from '../../../../backend/modules/memory/types';
import { upgradeToolNames } from '../../../../shared/toolNameUpgrades';

/**
 * 由提示词准备按会话环境追加的工具：Bot 附件只属于 Bot 会话，上下文笔记只在笔记管理或恢复时提供。
 * 默认 Agent 预先携带它们会让每次普通请求都多发这些声明，也让环境判断失去作用。
 */
const ENVIRONMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bot_read_attachment', 'bot_send_attachment', 'context_status', 'pet_control', ...CONTEXT_TOOL_NAMES,
]);

/** 默认 Agent 预先携带的工具：不含环境工具和当前宿主没有的浏览器。 */
function defaultToolName(app: PlatformApplication, name: string): boolean {
  return !ENVIRONMENT_TOOL_NAMES.has(name) && (app.browser !== undefined || !name.startsWith('browser_'));
}

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

/** 读取旧清单时先保留工程日志的操作范围，再升级工具名称；不改写已保存的配置。 */
export function upgradeAgentToolNames(agent: AgentDefinition): AgentDefinition {
  const upgraded = withEngineeringLogAgent(agent);
  return { ...upgraded, toolNames: upgradeToolNames(upgraded.toolNames) };
}

type ToolEnablement = Pick<SettingsManager, 'getToolsEnabled' | 'isToolEnabled'>;

/** 搜索与抓取共用同一份 DeepSeek 凭据；未配置时不发送声明，避免模型调用后必然失败。 */
function hasWebSearchCredential(preferences: SettingsManager): boolean {
  return preferences.getWebSearchConfig().apiKey.trim().length > 0;
}

/**
 * 合并工具中某个操作是否启用：用户单独设置过新名称时以新名称为准，否则沿用该操作原工具的启用项。
 * 工具清单、工程日志和终端的 argv / input 操作共用这一条规则。
 */
export function mergedOperationEnabled(preferences: ToolEnablement, toolName: string, legacyName: string): boolean {
  return preferences.isToolEnabled(Object.hasOwn(preferences.getToolsEnabled(), toolName) ? toolName : legacyName);
}

/** 桌面与 Bot 共用工具启用和审批配置，任务开始时捕获一次。 */
export function configuredAgent(app: PlatformApplication, agent: AgentDefinition): AgentDefinition {
  agent = upgradeAgentToolNames(agent);
  const preferences = app.product.runtimeSettings();
  const mcpNames = app.mcp.names();
  // 默认 Agent 跟随内置工具目录升级；自定义 Agent 沿用原清单，显式禁用项继续生效。
  const names = agent.id === 'default' ? app.tools.names().filter(name => !name.startsWith('mcp_')) : agent.toolNames;
  // 审批规则覆盖完整内置目录：环境工具之后由提示词准备追加，执行时仍需要同一套规则。
  const selected = agent.id === 'default' ? names.filter(name => defaultToolName(app, name)) : names;
  const webConfigured = hasWebSearchCredential(preferences);
  return { ...agent, toolNames: [...new Set([...selected, ...mcpNames])].filter(name =>
    (webConfigured || name !== 'web_search' && name !== 'web_fetch')
    && (name === 'engineering_log'
      ? Object.values(ENGINEERING_LOG_LEGACY_NAMES).some(legacy => mergedOperationEnabled(preferences, name, legacy))
      : preferences.isToolEnabled(name))),
    toolApproval: { ...toolApprovalRules(preferences, names, mcpNames), ...agent.toolApproval } };
}
