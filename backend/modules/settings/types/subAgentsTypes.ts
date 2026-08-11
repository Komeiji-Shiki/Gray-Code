/**
 * GrayCode - 子代理（SubAgents）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

import { DEFAULT_MAX_RUNTIME_S } from '../../../tools/subagents/types';

/**
 * 子代理工具配置
 */
export interface SubAgentToolsConfig {
    /**
     * 工具模式
     */
    mode: 'all' | 'builtin' | 'mcp' | 'whitelist' | 'blacklist';
    
    /**
     * 工具列表（白名单/黑名单模式下使用）
     */
    list?: string[];
}

/**
 * Provider 自动重试耗尽后的 SubAgent 处理策略。
 */
export type SubAgentFailureModeAfterRetries = 'fail_parent_tool' | 'wait_for_monitor_action';

/**
 * 子代理配置项
 */
export interface SubAgentConfigItem {
    /**
     * 子代理类型 ID（唯一标识符）
     */
    type: string;
    
    /**
     * 子代理名称（显示名称）
     */
    name: string;
    
    /**
     * 子代理描述
     */
    description: string;
    
    /**
     * 系统提示词
     */
    systemPrompt: string;
    
    /**
     * 渠道配置
     */
    channel: {
        channelId: string;
        modelId?: string;
    };
    
    /**
     * 工具配置
     */
    tools: SubAgentToolsConfig;
    
    /**
     * 最大迭代次数（-1 表示无限制）
     * 默认: 20
     */
    maxIterations?: number;
    
    /**
     * 最大运行时间（秒，-1 表示无限制）
     * 默认: 1800（30 分钟，同 DEFAULT_MAX_RUNTIME_S）
     */
    maxRuntime?: number;

    /**
     * Provider 自动重试耗尽后的处理策略，可覆盖全局默认值。
     */
    failureModeAfterRetries?: SubAgentFailureModeAfterRetries;
    
    /**
     * 是否启用
     */
    enabled: boolean;
}

/**
 * 子代理配置
 */
export interface SubAgentsConfig extends Record<string, unknown> {
    /**
     * 子代理列表
     */
    agents: SubAgentConfigItem[];
    
    /**
     * 同时运行的子代理数量上限，超出的自动排队（-1 表示无限制）
     * 默认: 3
     */
    maxConcurrentAgents?: number;

    /**
     * 全局默认的 Provider 自动重试耗尽处理策略。
     */
    failureModeAfterRetries?: SubAgentFailureModeAfterRetries;

    /**
     * 全局默认迭代次数（-1 表示无限制）。
     *
     * 未单独配置 maxIterations 的 agent（含 General Worker）继承该默认值；
     * 单独配置的 agent 优先使用自己的 maxIterations。默认 80。
     */
    defaultMaxIterations?: number;

    /**
     * 全局默认最大运行时间（秒，-1 表示无限制）。
     *
     * 未单独配置 maxRuntime 的 agent（含 General Worker）继承该默认值；
     * 单独配置的 agent 优先使用自己的 maxRuntime。默认 1800（30 分钟）。
     */
    defaultMaxRuntime?: number;

    /**
     * 是否启用通用 Worker（傻瓜式多 agent 模式）。
     *
     * 启用后主模型可直接派发零配置的 "General Worker"：
     * 继承主会话当前渠道与全部工具权限，数量由主模型自行决定，
     * 用户无需配置任何 agent。默认开启。
     */
    generalWorkerEnabled?: boolean;

    /**
     * 是否强制所有子代理使用当前会话渠道（全局开关）。
     *
     * 与 General Worker 的继承口径一致（channelConfigId + channelModelId）：
     * 勾选后，已配置固定渠道的子代理运行时也统一改用派发方当前正在使用的渠道，
     * 忽略各自配置的渠道与模型；未勾选（默认）时各子代理使用自己的固定渠道。
     * 渠道切换（备用 key/新供应商）时无需逐个修改子代理。
     */
    forceUseCurrentChannel?: boolean;
}

/**
 * 默认子代理配置
 */
export const DEFAULT_SUBAGENTS_CONFIG: SubAgentsConfig = {
    agents: [],
    maxConcurrentAgents: 3,
    failureModeAfterRetries: 'fail_parent_tool',
    generalWorkerEnabled: true,
    defaultMaxIterations: 80,
    defaultMaxRuntime: DEFAULT_MAX_RUNTIME_S
};
