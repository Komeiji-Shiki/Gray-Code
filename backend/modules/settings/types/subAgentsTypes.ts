/**
 * GrayCode - 子代理（SubAgents）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

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

        /**
         * 是否与该子代理派发时当前会话的渠道/模型同步（逐代理开关）。
         *
         * 勾选后该子代理忽略自身固定的 channelId/modelId，运行时统一改用
         * 派发方当前正在使用的渠道与模型（channelConfigId + channelModelId），
         * 与 General Worker 的继承口径一致；渠道切换（备用 key/新供应商）时
         * 无需逐个修改子代理。未勾选（默认）时使用自身固定渠道与模型。
         */
        syncWithCurrentModel?: boolean;
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
     * 默认: 300 (5分钟)
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
     * 是否启用通用 Worker（傻瓜式多 agent 模式）。
     *
     * 启用后主模型可直接派发零配置的 "General Worker"：
     * 继承主会话当前渠道与全部工具权限，数量由主模型自行决定，
     * 用户无需配置任何 agent。默认开启。
     */
    generalWorkerEnabled?: boolean;

    /**
     * 排队等待并发席位的超时（秒，-1 无限制），默认 600。
     *
     * 子代理超出 maxConcurrentAgents 时进入全局 FIFO 队列；
     * 排队超过该时间后该 run 以失败结算（而非用户取消），不再无限等待。
     */
    queueTimeoutSeconds?: number;

    /**
     * （已废弃）是否强制所有子代理使用当前会话渠道（全局开关）。
     *
     * 该全局开关已下放为每个子代理渠道配置上的 syncWithCurrentModel 逐代理开关。
     * 本字段仅保留用于旧配置向后兼容迁移：为 true 且某代理未显式设置
     * syncWithCurrentModel 时，运行时按旧语义视同该代理与当前渠道同步；
     * 新 UI 不再写入/展示该字段，代理显式设置 false 后即恢复固定渠道。
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
    queueTimeoutSeconds: 600
};
