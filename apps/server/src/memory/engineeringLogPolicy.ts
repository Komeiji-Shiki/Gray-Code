import type { AgentDefinition } from '@graycode/contracts';
import { ENGINEERING_LOG_LEGACY_NAMES } from '../../../../backend/modules/memory/types';

/** 显式选择合并工具表示选择全部操作；旧清单只开放当时列出的操作。 */
export function engineeringLogActionRestrictions(names: readonly string[]): Record<string, 'deny'> {
  const legacy: readonly string[] = Object.values(ENGINEERING_LOG_LEGACY_NAMES);
  if (names.includes('engineering_log') || !names.some(name => legacy.includes(name))) return {};
  return Object.fromEntries(legacy.filter(name => !names.includes(name)).map(name => [name, 'deny']));
}

/** 自定义 Agent 原来只选择部分操作时，合并目录不能扩大它的能力。 */
export function withEngineeringLogAgent(agent: AgentDefinition): AgentDefinition {
  const legacy = Object.values(ENGINEERING_LOG_LEGACY_NAMES);
  const legacySet = new Set<string>(legacy);
  if (!agent.toolNames.some(name => legacySet.has(name))) return agent;
  return {
    ...agent,
    toolNames: [...new Set(agent.toolNames.map(name => legacySet.has(name) ? 'engineering_log' : name))],
    toolApproval: { ...agent.toolApproval, ...(agent.id === 'default' ? {} : engineeringLogActionRestrictions(agent.toolNames)) },
  };
}
