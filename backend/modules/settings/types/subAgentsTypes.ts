import type { SubAgentsConfig } from '../../../../packages/contracts/src/subagents';
export type { SubAgentToolsConfig, SubAgentFailureModeAfterRetries, SubAgentConfigItem, SubAgentConfigUpdate, SubAgentsConfig } from '../../../../packages/contracts/src/subagents';

/**
 * 默认子代理配置
 */
export const DEFAULT_SUBAGENTS_CONFIG: SubAgentsConfig = {
    agents: [],
    maxConcurrentAgents: 3,
    failureModeAfterRetries: 'fail_parent_tool',
    generalWorkerEnabled: true,
    generalWorkerMaxRuntimeSeconds: 2400,
    defaultMaxIterations: 80,
    queueTimeoutSeconds: 600,
    defaultMaxRuntimeSeconds: 1800
};
